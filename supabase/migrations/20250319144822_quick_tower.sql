/*
  # Create messages table for chat history

  1. New Tables
    - `messages`
      - `id` (uuid, primary key)
      - `content` (text, message content)
      - `created_at` (timestamp)
      - `is_ai` (boolean, indicates if message is from AI)

  2. Security
    - Enable RLS on `messages` table
    - Add policy for public read access
    - Add policy for system to insert messages
*/

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  created_at timestamptz DEFAULT now(),
  is_ai boolean DEFAULT false
);

-- Enable RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Anyone can read messages"
  ON messages
  FOR SELECT
  TO public
  USING (true);

-- Allow system to insert messages
CREATE POLICY "System can insert messages"
  ON messages
  FOR INSERT
  TO authenticated
  WITH CHECK (true);