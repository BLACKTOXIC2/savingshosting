-- Create brands table
create table if not exists public.brands (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    brand_image text,
    affiliate_url text,
    brand_name text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Set up row level security (RLS)
alter table public.brands enable row level security;

-- Create policies
create policy "Users can view their own brands"
    on public.brands for select
    using (auth.uid() = user_id);

create policy "Users can insert their own brands"
    on public.brands for insert
    with check (auth.uid() = user_id);

create policy "Users can update their own brands"
    on public.brands for update
    using (auth.uid() = user_id);

create policy "Users can delete their own brands"
    on public.brands for delete
    using (auth.uid() = user_id);