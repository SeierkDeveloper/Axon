-- Agent Studio, phase 4: changes asked for in Studio's chat ("make it shorter"), counted per build and kept as a log.
ALTER TABLE studio_builds ADD COLUMN tweaks TEXT;
