# SOTSBA — ligação Web + Backend

## Local
1. Na raiz: `docker compose up --build`
2. API: http://localhost:4000/api/health
3. Publique a pasta `web` ou abra o `web/index.html`.
4. Se o navegador não estiver em localhost, configure:
   localStorage.setItem('SOTSBA_API_URL','http://SEU_HOST:4000')

## Produção
- Suba `backend` como container em um serviço de backend.
- Crie PostgreSQL gerenciado.
- Configure DATABASE_URL, JWT_SECRET, OPENAI_API_KEY e CORS_ORIGIN.
- No Netlify, publique `web`.
- Aponte SOTSBA_API_URL para a URL HTTPS da API.

## Importante
A chave OPENAI_API_KEY fica somente no backend. Nunca coloque a chave no frontend.
