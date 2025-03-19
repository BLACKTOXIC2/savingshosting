DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_type') THEN
    CREATE TYPE deal_type AS ENUM ('coupon', 'deal');
  END IF;
END $$;

CREATE TABLE coupons_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type deal_type NOT NULL,
  brand_id UUID REFERENCES brands(id) NOT NULL,
  coupon_code TEXT,
  deal_url TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  expiry_time TIMESTAMPTZ NOT NULL,
  offer_percentage NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE coupons_deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert coupons and deals for their brands" ON coupons_deals
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM brands
      WHERE id = brand_id
      AND user_id = auth.uid()
    )
  );