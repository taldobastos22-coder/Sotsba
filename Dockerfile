FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install -g npm@10
RUN npm install

COPY . .

RUN npx prisma generate --schema=backend/prisma/schema.prisma

RUN npm run build

EXPOSE 4000

CMD ["sh", "-c", "npx prisma db push --schema=backend/prisma/schema.prisma && npm start"]
