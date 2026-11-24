# Image Compressor

Compress still JPEG, PNG, and WebP images to a byte limit. The browser worker processes images locally by default. If it cannot complete a file, the user can explicitly upload that file to the optional local Go and libvips service.

## Run locally

Install Node.js, Go 1.22 or later, and libvips with the `vips` and `vipsheader` executables on your path. On macOS, Homebrew can install these with `brew install go vips`.

From this project directory:

```sh
npm ci
npm run dev
```

Open the URL Vite prints. To enable the fallback, run this in a second terminal from the project directory:

```sh
cd server
go run .
```

Vite proxies `/api/compress` to Go on port 8080. To serve the production build and API together, run `npm run build` from the project directory and `go run .` from `server`. Open http://127.0.0.1:8080.

## Verify

Run `npm run build` for type checking and production bundle sizes. Run `go test -v ./...` from `server` for libvips-backed integration checks.

## AI upscaling

Photo AI 2× uses the [Real-ESRGAN General x4v3 ONNX checkpoint](https://huggingface.co/qualcomm/Real-ESRGAN-General-x4v3/blob/3d7e0904d26b0e2202f361b95d360f22baa69a04/Real-ESRGAN-General-x4v3.onnx) and single-threaded ONNX Runtime Web in a browser worker. It processes overlapping 128 × 128 tiles and reduces each native 4× prediction to 2×. The full output canvas is 2×. The optional assets include a 4.87 MB checkpoint and a 14.85 MB WASM binary before transport compression. The model is distributed with the [upstream Real-ESRGAN license](public/real-esrgan-LICENSE.txt).

Light AI 2× uses the [full FSRCNN TensorFlow model](https://github.com/Saafke/FSRCNN_Tensorflow/blob/master/models/FSRCNN_x2.pb). The 33,988-byte little-endian weights file contains the original float32 kernels, biases and PReLU slopes extracted from the upstream graph. The browser loads it only when Light AI runs. The [upstream Apache 2.0 license](public/fsrcnn-LICENSE.txt) accompanies the weights.

Inference runs in 64-pixel tiles with six pixels of context. The app uses the model for luminance, browser resizing for color and transparency, and WebP encoding for the export. AI 2× processes inputs up to 2 megapixels and 4,096 pixels per side. Standard upscaling is available for larger files and 4× enlargement.
