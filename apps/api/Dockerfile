# Ίδιο μοτίβο με apps/stream/Dockerfile: context η ρίζα του monorepo, γιατί το
# package-lock.json (npm workspaces) ζει εκεί. slim (glibc) — το prisma engine
# binary παραπάνω είναι debian-openssl, σε alpine/musl δεν θα έτρεχε.
# openssl: χωρίς αυτό το prisma generate δεν βρίσκει libssl και διαλέγει engine
# στα τυφλά (openssl-1.1.x) — σε νεότερο base image μπορεί να είναι λάθος.
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
# `ci` όχι `install`, ίδιος λόγος με το stream: reproducible builds. Εδώ θέλουμε
# ΚΑΙ τα devDependencies (typescript, @nestjs/cli) — το build χρειάζεται tsc.
RUN npm ci -w apps/api

COPY apps/api/ apps/api/
RUN npm run build -w apps/api

# ── Runtime: μόνο production deps, χωρίς @nestjs/cli/typescript ─────────────
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci --omit=dev -w apps/api

COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api

# Χωρίς root: ο φάκελος των δεδομένων φτιάχνεται ΣΤΟ IMAGE και ανήκει στον node,
# ώστε το named volume να κληρονομήσει την ιδιοκτησία του όταν το αρχικοποιεί το
# Docker — εκεί γράφει το `prisma db push` και το sqlite.
# Υπάρχουσα εγκατάσταση (volume φτιαγμένο ως root) θέλει μία φορά:
#   docker compose exec -u root api chown -R node:node /app/apps/api/data
RUN mkdir -p /app/apps/api/data && chown -R node:node /app/apps/api
USER node

EXPOSE 3000

# Το `prisma` CLI μένει dependency (όχι dev) ειδικά γι' αυτό: schema.prisma
# είναι η μόνη πηγή αλήθειας, `db push` το εφαρμόζει idempotent σε κάθε boot —
# δεν αξίζει ξεχωριστό migrations directory για μια χούφτα πίνακες.
# node_modules είναι hoisted στη ρίζα του workspace (/app), όχι εδώ μέσα.
CMD ["sh", "-c", "node /app/node_modules/prisma/build/index.js db push --skip-generate --schema=prisma/schema.prisma && node --env-file-if-exists=.env dist/src/main.js"]
