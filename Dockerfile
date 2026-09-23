FROM node:22-alpine

WORKDIR /app

# Copia as dependências
COPY package*.json ./

# Atualiza o npm
RUN npm install -g npm@11

# Instala as dependências
RUN npm install

# Copia todo o projeto
COPY . .

# Gera o Prisma Client usando o schema correto
RUN npx prisma generate --schema=backend/prisma/schema.prisma

# Compila o TypeScript
RUN npm run build

# Porta utilizada pelo Render
EXPOSE 10000

# Inicia a API
CMD ["node", "dist/server.js"]
