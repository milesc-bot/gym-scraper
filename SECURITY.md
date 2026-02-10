# Security

## Before pushing to GitHub

- **Do not commit `.env`** or any file containing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`.  
  These are listed in `.gitignore`; keep them only on your machine or in your deployment secrets.

- **Use `.env.example` as a template only.**  
  It has empty values on purpose. Copy it to `.env` locally and fill in real values; `.env` is ignored by git.

- **If you ever accidentally commit a key:**  
  1. Rotate the key immediately in the Supabase dashboard (Project Settings → API).  
  2. Remove the key from git history (e.g. `git filter-branch` or BFG Repo-Cleaner) and force-push.  
  3. Treat the old key as compromised; do not reuse it.

## How this project handles secrets

- Supabase URL and service-role key are read from **environment variables** in `src/services/supabaseService.ts` (no hardcoded credentials).
- The scraper does not log request/response bodies or keys; only natural-language progress messages are logged.
- No API keys, tokens, or passwords appear in the repository.

## Reporting a vulnerability

If you find a security issue in this project, please report it responsibly (e.g. via a private channel or GitHub Security Advisories) rather than opening a public issue.
