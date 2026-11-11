-- Several photos per item. image_urls holds them in display order;
-- image_url stays as the cover (always image_urls[1] when there are any)
-- so older clients and scripts that only send/read image_url keep working.
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';

UPDATE items SET image_urls = ARRAY[image_url]
WHERE image_url <> '' AND cardinality(image_urls) = 0;
