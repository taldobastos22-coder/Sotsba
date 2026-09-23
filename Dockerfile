FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install -g npm@11
RUN npm install

COPY . .

RUN npx prisma generate --schema=backend/prisma/schema.prisma
RUN npm run build

EXPOSE 10000

CMD ["node", "dist/server.js"]
