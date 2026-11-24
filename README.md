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
