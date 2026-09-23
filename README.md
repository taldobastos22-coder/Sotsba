# SOTSBA — Full Stack

Estrutura pronta para colocar no GitHub e conectar ao Render.

## Estrutura
- `web/` = frontend estático para Netlify
- `src/` = backend Node/Express
- `prisma/schema.prisma` = banco PostgreSQL
- `Dockerfile` = build do backend no Render

## Render
Configure o serviço Docker com:
- Root Directory: vazio
- Dockerfile Path: Dockerfile
- Docker Build Context Directory: .
- Environment variables: DATABASE_URL, JWT_SECRET, CORS_ORIGIN
- OPENAI_API_KEY é opcional até a integração real de IA.

## Netlify
Publique somente o conteúdo da pasta `web/`.

O frontend já aponta por padrão para:
https://sotsba-backend.onrender.com

Se o endereço do backend mudar:
localStorage.setItem('SOTSBA_API_URL', 'https://SEU-BACKEND.onrender.com')


## Pagamentos
Integração Stripe para assinaturas recorrentes. Veja `STRIPE_SETUP.md`.
