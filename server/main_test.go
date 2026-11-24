package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
)

func TestCompress(t *testing.T) {
	for _, name := range []string{"vips", "vipsheader"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip(err)
		}
	}
	img := image.NewNRGBA(image.Rect(0, 0, 320, 200))
	for y := range 200 {
		for x := range 320 {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * y), uint8(x + y), uint8(x * 3), uint8(y * 2)})
		}
	}
	var original bytes.Buffer
	if err := png.Encode(&original, img); err != nil {
		t.Fatal(err)
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, img, nil); err != nil {
		t.Fatal(err)
	}
	// APP1 Exif with a little-endian TIFF orientation of 6 (90° clockwise).
	orientation := []byte{0xff, 0xe1, 0, 34, 'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	rotated := append(append(append([]byte{}, jpegData.Bytes()[:2]...), orientation...), jpegData.Bytes()[2:]...)
	boundaryPNG := make([]byte, 1_000_000)
	copy(boundaryPNG, original.Bytes())
	for _, tc := range []struct {
		name, limit, edge string
		data              []byte
		max, status       int
	}{
		{"passthrough", "999999", "", original.Bytes(), 999999, 200},
		{"strict boundary", "999999", "", boundaryPNG, 999999, 200},
		{"rotated passthrough", "999999", "", rotated, 999999, 200},
		{"resize and compress", "3000", "160", original.Bytes(), 3000, 200},
		{"corrupt", "999999", "", []byte("corrupt"), 0, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			part, _ := form.CreateFormFile("image", "image.png")
			_, _ = part.Write(tc.data)
			_ = form.WriteField("limit", tc.limit)
			_ = form.WriteField("edge", tc.edge)
			_ = form.Close()
			request := httptest.NewRequest(http.MethodPost, "/api/compress", &body)
			request.Header.Set("Content-Type", form.FormDataContentType())
			response := httptest.NewRecorder()
			handle(response, request)
			if response.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			if tc.status != 200 {
				return
			}
			if response.Body.Len() < 1 || response.Body.Len() > tc.max || format(response.Body.Bytes()) == "" {
				t.Fatalf("invalid encoded result (%d bytes)", response.Body.Len())
			}
			if len(tc.data) <= tc.max && tc.edge == "" && !bytes.Equal(tc.data, response.Body.Bytes()) {
				t.Fatal("the original bytes changed")
			}
			if tc.name == "rotated passthrough" && (response.Header().Get("X-Image-Width") != "200" || response.Header().Get("X-Image-Height") != "320") {
				t.Fatal("result dimensions must reflect EXIF orientation")
			}
		})
	}
}
