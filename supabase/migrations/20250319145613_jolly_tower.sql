/*
  # Create brands and deals tables

  1. New Tables
    - `brands`
      - `id` (uuid, primary key)
      - `brand_name` (text, unique)
      - `created_at` (timestamp)
    - `coupons_deals`
      - `id` (uuid, primary key)
      - `type` (deal_type enum: 'coupon' or 'deal')
      - `brand_id` (uuid, references brands)
      - `coupon_code` (text)
      - `deal_url` (text)
      - `title` (text)
      - `description` (text)
      - `start_time` (timestamp)
      - `expiry_time` (timestamp)
      - `offer_percentage` (numeric)
      - `created_at` (timestamp)

  2. Security
    - Enable RLS on both tables
    - Add policies for public read access
    - Add policies for authenticated users to manage their data
*/

-- Create deal_type enum if not exists
DO $$ BEGIN
  CREATE TYPE deal_type AS ENUM ('coupon', 'deal');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create brands table
CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create coupons_deals table
CREATE TABLE IF NOT EXISTS coupons_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type deal_type NOT NULL,
  brand_id uuid REFERENCES brands(id) NOT NULL,
  coupon_code text,
  deal_url text,
  title text NOT NULL,
  description text NOT NULL,
  start_time timestamptz NOT NULL DEFAULT now(),
  expiry_time timestamptz NOT NULL,
  offer_percentage numeric(5,2),
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons_deals ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow public read access to brands"
  ON brands
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public read access to coupons_deals"
  ON coupons_deals
  FOR SELECT
  TO public
  USING (true);

-- Insert sample data
INSERT INTO brands (id, brand_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Hostinger'),
  ('22222222-2222-2222-2222-222222222222', 'AWS'),
  ('33333333-3333-3333-3333-333333333333', 'Linode'),
  ('44444444-4444-4444-4444-444444444444', 'DigitalOcean')
ON CONFLICT (brand_name) DO NOTHING;

INSERT INTO coupons_deals (
  type,
  brand_id,
  coupon_code,
  deal_url,
  title,
  description,
  start_time,
  expiry_time,
  offer_percentage
) VALUES
  (
    'coupon',
    '11111111-1111-1111-1111-111111111111',
    'HOST50',
    null,
    'Hostinger 50% Off Hosting',
    'Get 50% off on all hosting plans',
    now(),
    now() + interval '30 days',
    50.00
  ),
  (
    'deal',
    '22222222-2222-2222-2222-222222222222',
    null,
    'https://aws.amazon.com/free',
    'AWS Free Tier',
    'Get started with AWS Free Tier',
    now(),
    now() + interval '60 days',
    100.00
  ),
  (
    'coupon',
    '33333333-3333-3333-3333-333333333333',
    'LINODE25',
    null,
    'Linode 25% Discount',
    'Save 25% on your first 3 months',
    now(),
    now() + interval '45 days',
    25.00
  ),
  (
    'deal',
    '44444444-4444-4444-4444-444444444444',
    null,
    'https://digitalocean.com/try',
    'DigitalOcean $100 Credit',
    'Get $100 credit for new accounts',
    now(),
    now() + interval '30 days',
    null
  );