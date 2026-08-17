# Ίδιο μοτίβο με τα apps/stream και apps/api Dockerfile: context η ρίζα του
# monorepo, γιατί το package-lock.json (npm workspaces) ζει εκεί.
#
# Το UI δεν τρέχει, μεταγλωττίζεται: `nuxt generate` βγάζει στατικά αρχεία και
# από κει και πέρα το image του Caddy τα κουβαλάει μόνο του. Ένα image αντί για
# shared volume ώστε build και σερβίρισμα να μην χρειάζονται συγχρονισμό — το
# `docker compose up -d --build` φτιάχνει και τα δύο μαζί, ατομικά.
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/panel/package.json apps/panel/
RUN npm ci -w apps/panel

COPY apps/panel/ apps/panel/
RUN npm run generate -w apps/panel

FROM caddy:2
COPY --from=build /app/apps/panel/.output/public /srv
