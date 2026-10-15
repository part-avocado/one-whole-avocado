FROM node:22-alpine

ARG GIT_COMMIT=unknown
ENV NODE_ENV=production GIT_COMMIT=$GIT_COMMIT
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
CMD ["node", "src/app.js"]
