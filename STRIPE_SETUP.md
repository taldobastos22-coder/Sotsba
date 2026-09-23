# SOTSBA — configuração de assinaturas Stripe

## Planos
- Basic: R$ 29,90/mês — 100 créditos
- Professional: R$ 59,90/mês — 300 créditos
- Agency: R$ 149,90/mês — 1.000 créditos

## Variáveis no Render
Configure:
- `STRIPE_SECRET_KEY` = chave secreta da Stripe
- `STRIPE_WEBHOOK_SECRET` = segredo do endpoint de webhook
- `STRIPE_PRICE_BASIC` = ID do Price recorrente do Basic
- `STRIPE_PRICE_PROFESSIONAL` = ID do Price recorrente do Professional
- `STRIPE_PRICE_AGENCY` = ID do Price recorrente do Agency
- `APP_URL` = URL do Netlify

## Stripe Dashboard
1. Crie os três produtos e preços recorrentes mensais.
2. Copie cada ID `price_...` para a variável correspondente no Render.
3. Crie um webhook apontando para `https://sotsba-backend.onrender.com/api/billing/webhook`.
4. Assine os eventos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
5. Copie o `whsec_...` do endpoint para `STRIPE_WEBHOOK_SECRET`.
6. Faça um deploy do backend.

## Recebimento
A Stripe processa a cobrança do cliente e faz os repasses para a conta bancária cadastrada na sua conta Stripe, conforme o cronograma de repasses aplicável à sua conta.

## Importante
- Nunca coloque `STRIPE_SECRET_KEY` ou `STRIPE_WEBHOOK_SECRET` no Netlify/front-end.
- Use apenas variáveis de ambiente no Render.
- Para produção, a conta Stripe precisa estar configurada/verificada para receber pagamentos.
