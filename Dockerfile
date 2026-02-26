FROM node:22-slim AS build

WORKDIR /app
COPY client/package*.json ./client/
RUN npm ci --prefix client
COPY client/ ./client/
RUN npm run build --prefix client

FROM node:22-slim

WORKDIR /app
COPY server/package*.json ./server/
RUN npm ci --prefix server --omit=dev
COPY server/ ./server/
COPY --from=build /app/client/dist ./client/dist

RUN mkdir -p /media
VOLUME /media

EXPOSE 3000
CMD ["node", "server/index.js"]
