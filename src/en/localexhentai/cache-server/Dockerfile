FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install
COPY src/ ./src/

EXPOSE 3000

VOLUME /app/cache

CMD ["node", "src/index.js"]
