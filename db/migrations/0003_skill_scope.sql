-- Phase B: which video category a skill serves, what concept it teaches, and which agent reads it. Additive.
-- skills.category now holds the video category (saas | ecommerce | general-promo | all); the concept lives in `topic`.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS topic text NOT NULL DEFAULT 'general';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'both' CHECK (scope IN ('director', 'editor', 'both'));
CREATE INDEX IF NOT EXISTS skills_topic_idx ON skills (topic);
