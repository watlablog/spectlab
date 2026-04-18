# Deploy

## Static Hosting Overview

SpectLab is a static Vite application. Deploy the contents of `dist/` to your web root and make sure the server falls back to `index.html` for SPA routes such as `/recording`.

## Sakura Rental Server

1. Run `npm run build`.
2. Upload every file inside `dist/` to the public document root for `https://spectlab-watlab.com/`.
3. Keep the generated `.htaccess` file at the same level as `index.html`.
4. Confirm that `https://spectlab-watlab.com/recording` opens the app directly.

The `.htaccess` file is sourced from [public/.htaccess](./public/.htaccess) and is copied into `dist/` during `vite build`.

## Notes

- Root-path asset URLs are expected. Do not deploy the app as a nested `/recording/` subdirectory build.
- Microphone access requires HTTPS in production.
- If you use another static host, configure equivalent SPA fallback behavior to `index.html`.
