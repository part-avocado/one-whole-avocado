FROM node:22-alpine

ARG GIT_COMMIT=unknown
ARG GIT_MESSAGE=
ENV NODE_ENV=production GIT_COMMIT=$GIT_COMMIT GIT_MESSAGE=$GIT_MESSAGE
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
CMD ["node", "src/app.js"]
