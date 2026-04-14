-- 建立 documents 表
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    owner TEXT,
    expiry DATE,
    recurrence TEXT DEFAULT 'none',
    recurrence_custom_years SMALLINT,
    remind_days SMALLINT DEFAULT 30,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 啟用 RLS (Row Level Security)
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- 建立 RLS 政策：用戶只能看到自己的數據
CREATE POLICY "Users can only see their own documents"
    ON public.documents
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 建立索引
CREATE INDEX idx_documents_user_id ON public.documents(user_id);
CREATE INDEX idx_documents_expiry ON public.documents(expiry);

-- 自動更新 updated_at 的觸發器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_documents_updated_at ON public.documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON public.documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
