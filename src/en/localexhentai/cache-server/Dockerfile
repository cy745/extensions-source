FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install
COPY src/ ./src/
COPY web/dist/ ./web/dist/

EXPOSE 3000

VOLUME /app/cache

CMD ["node", "src/index.js"]
