package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const maxUpload = 32_000_000
const maxPixels = 24_000_000

var slots = make(chan struct{}, 2)

func vips(ctx context.Context, command string, args ...string) ([]byte, error) {
	process := exec.CommandContext(ctx, command, args...)
	process.Env = append(os.Environ(), "VIPS_CONCURRENCY=2")
	return process.Output()
}

func dimensions(ctx context.Context, path string) (int, int, error) {
	values := [2]int{}
	for i, field := range []string{"width", "height"} {
		out, err := vips(ctx, "vipsheader", "-f", field, path)
		if err != nil {
			return 0, 0, err
		}
		values[i], err = strconv.Atoi(strings.TrimSpace(string(out)))
		if err != nil || values[i] < 1 {
			return 0, 0, fmt.Errorf("invalid dimensions")
		}
	}
	return values[0], values[1], nil
}

func format(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{255, 216, 255}):
		return "jpg"
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		for p := 8; p+12 <= len(data); {
			if string(data[p+4:p+8]) == "acTL" {
				return ""
			}
			p += 12 + int(binary.BigEndian.Uint32(data[p:p+4]))
		}
		return "png"
	case len(data) >= 30 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		if string(data[12:16]) == "VP8X" && data[20]&2 != 0 {
			return ""
		}
		return "webp"
	}
	return ""
}

func sample(ctx context.Context, path, output string, w, h int) (image.Image, error) {
	_, err := vips(ctx, "vips", "thumbnail", path, output+"[strip]", strconv.Itoa(w), "--height", strconv.Itoa(h), "--size", "force")
	if err != nil {
		return nil, err
	}
	file, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return png.Decode(file)
}

func difference(original, result image.Image) float64 {
	var total float64
	bounds := original.Bounds()
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			r, g, b, a := original.At(x, y).RGBA()
			s, t, u, v := result.At(x, y).RGBA()
			total += math.Pow(float64(r)-float64(s), 2) + math.Pow(float64(g)-float64(t), 2) +
				math.Pow(float64(b)-float64(u), 2) + 3*math.Pow(float64(a)-float64(v), 2)
		}
	}
	return total / (float64(bounds.Dx()*bounds.Dy()*4) * 257 * 257)
}

type result struct {
	data          []byte
	ext           string
	width, height int
}

func optimize(ctx context.Context, dir string, original []byte, ext string, limit, edge int) (result, error) {
	input := filepath.Join(dir, "input."+ext)
	if err := os.WriteFile(input, original, 0600); err != nil {
		return result{}, err
	}
	w, h, err := dimensions(ctx, input)
	if err != nil || w > maxPixels/h {
		return result{}, fmt.Errorf("invalid image or pixel limit exceeded")
	}
	decoded := filepath.Join(dir, "original.v")
	if _, err := vips(ctx, "vips", "autorot", input+"[fail-on=error]", decoded); err != nil {
		return result{}, fmt.Errorf("could not decode image")
	}
	w, h, err = dimensions(ctx, decoded)
	if err != nil {
		return result{}, err
	}
	long := max(w, h)
	if len(original) <= limit && (edge == 0 || long <= edge) {
		return result{original, ext, w, h}, nil
	}
	base := long
	if edge > 0 {
		base = min(base, edge)
	}
	scale := float64(min(base, 384)) / float64(long)
	reference, err := sample(ctx, decoded, filepath.Join(dir, "reference.png"), max(1, int(math.Round(float64(w)*scale))), max(1, int(math.Round(float64(h)*scale))))
	if err != nil {
		return result{}, err
	}
	formats := []string{ext}
	if ext != "webp" {
		formats = append(formats, "webp")
	}
	best, bestScore := result{}, math.Inf(1)
	firstFit := -1
	for step := 0; step < 9; step++ {
		target := max(1, int(float64(base)*math.Pow(0.78, float64(step))))
		resized := filepath.Join(dir, "resized.v")
		if _, err := vips(ctx, "vips", "thumbnail", decoded, resized, strconv.Itoa(target), "--height", strconv.Itoa(target), "--size", "down"); err != nil {
			return result{}, err
		}
		rw, rh, err := dimensions(ctx, resized)
		if err != nil {
			return result{}, err
		}
		for _, candidateExt := range formats {
			path := filepath.Join(dir, "candidate."+candidateExt)
			var candidate []byte
			low, high := 8, 98
			for attempt := 0; attempt < 7 && low <= high; attempt++ {
				quality := (low + high) / 2
				if attempt == 0 {
					quality = high
				} else if attempt == 1 {
					quality = low
				}
				options := fmt.Sprintf("[strip,Q=%d]", quality)
				if candidateExt == "png" {
					options = "[strip,compression=6]"
				}
				if _, err := vips(ctx, "vips", "copy", resized, path+options); err != nil {
					return result{}, err
				}
				info, err := os.Stat(path)
				if err != nil {
					return result{}, err
				}
				if info.Size() <= int64(limit) {
					candidate, err = os.ReadFile(path)
					if err != nil {
						return result{}, err
					}
					low = quality + 1
				} else {
					high = quality - 1
				}
				if candidateExt == "png" {
					break
				}
			}
			if candidate == nil {
				continue
			}
			if err := os.WriteFile(path, candidate, 0600); err != nil {
				return result{}, err
			}
			check, err := sample(ctx, path, filepath.Join(dir, "sample.png"), reference.Bounds().Dx(), reference.Bounds().Dy())
			if err != nil {
				return result{}, err
			}
			score := difference(reference, check) + 2*(1-float64(max(rw, rh))/float64(base))
			if candidateExt != ext {
				score += 0.15
			}
			if score < bestScore {
				best, bestScore = result{candidate, candidateExt, rw, rh}, score
			}
		}
		if best.data != nil && firstFit < 0 {
			firstFit = step
		}
		if (firstFit >= 0 && step > firstFit) || bestScore <= 0.15 || target == 1 {
			break
		}
	}
	return best, nil
}

func handle(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 50*time.Second)
	defer cancel()
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	case <-ctx.Done():
		http.Error(w, "Compression timed out.", http.StatusRequestTimeout)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+65536)
	err := r.ParseMultipartForm(maxUpload)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		http.Error(w, "Choose an image under 32 MB.", http.StatusBadRequest)
		return
	}
	limit, err := strconv.Atoi(r.FormValue("limit"))
	edge, edgeErr := strconv.Atoi(r.FormValue("edge"))
	if err != nil || limit <= 0 || (r.FormValue("edge") != "" && (edgeErr != nil || edge < 1)) {
		http.Error(w, "Choose a valid size limit and dimensions.", http.StatusBadRequest)
		return
	}
	file, _, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "Choose an image.", http.StatusBadRequest)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUpload+1))
	ext := format(data)
	if err != nil || len(data) > maxUpload || ext == "" {
		http.Error(w, "Choose a still JPEG, PNG or WebP under 32 MB.", http.StatusBadRequest)
		return
	}
	dir, err := os.MkdirTemp("", "compress-")
	if err != nil {
		http.Error(w, "Server compression is unavailable.", http.StatusServiceUnavailable)
		return
	}
	defer os.RemoveAll(dir)
	out, err := optimize(ctx, dir, data, ext, limit, edge)
	if err != nil || len(out.data) == 0 || len(out.data) > limit {
		http.Error(w, "The server could not fit this image within the selected limit.", http.StatusUnprocessableEntity)
		return
	}
	mime := out.ext
	if mime == "jpg" {
		mime = "jpeg"
	}
	w.Header().Set("Content-Type", "image/"+mime)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Image-Width", strconv.Itoa(out.width))
	w.Header().Set("X-Image-Height", strconv.Itoa(out.height))
	_, _ = w.Write(out.data)
}

func main() {
	for _, binary := range []string{"vips", "vipsheader"} {
		if _, err := exec.LookPath(binary); err != nil {
			log.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/compress", handle)
	mux.Handle("/", http.FileServer(http.Dir("../dist")))
	server := &http.Server{Addr: "127.0.0.1:8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 60 * time.Second}
	log.Printf("Listening on http://%s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
