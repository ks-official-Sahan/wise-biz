-- Product images (P1-02d). The client resizes in the browser/app and uploads every size straight to object storage
-- through presigned PUTs (no image library on the server); `confirm` makes the media visible.
ALTER TABLE catalog.product_media
  ADD COLUMN content_type text NOT NULL DEFAULT 'image/webp'
    CHECK (content_type IN ('image/webp', 'image/jpeg', 'image/png')),
  -- Pixel widths stored under asset_key: "<asset_key>/<width>.<ext>" plus "original".
  ADD COLUMN sizes text[] NOT NULL DEFAULT '{original}',
  ADD COLUMN uploaded_at timestamptz;

GRANT UPDATE (uploaded_at, position, alt) ON catalog.product_media TO wb_app;
