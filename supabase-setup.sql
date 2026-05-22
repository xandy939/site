-- Supabase SQL para criar a tabela de perfis associados aos utilizadores autenticados.

create table if not exists profiles (
  id uuid references auth.users not null primary key,
  first_name text,
  last_name text,
  phone text,
  age int,
  gender text,
  created_at timestamp with time zone default now()
);

alter table profiles enable row level security;

-- Remove as políticas se elas já existirem para evitar o erro 42710
drop policy if exists "Self profile access" on profiles;
drop policy if exists "Self profile insert" on profiles;
drop policy if exists "Self profile update" on profiles;
drop policy if exists "Self profile delete" on profiles;

-- Criação limpa das políticas de segurança (RLS)
create policy "Self profile access" on profiles
  for select using (auth.uid() = id);

create policy "Self profile insert" on profiles
  for insert with check (auth.uid() = id);

create policy "Self profile update" on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "Self profile delete" on profiles
  for delete using (auth.uid() = id);

-- Função que cria automaticamente um perfil quando um novo utilizador é registado
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, first_name, last_name, phone, age, gender)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    new.raw_user_meta_data->>'phone',
    (new.raw_user_meta_data->>'age')::int,
    new.raw_user_meta_data->>'gender'
  );
  return new;
end;
$$ language plpgsql security definer;

-- Trigger que executa a função quando um novo utilizador é criado
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();