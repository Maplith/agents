# The wake relay has no dependencies: copy the sources and run them.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json relay.config.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.mjs"]
