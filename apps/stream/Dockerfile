# slim, όχι alpine: το bcrypt (μέσω @hosterai/passwords) έχει prebuilt binaries μόνο
# για glibc — σε musl θα ήθελε ολόκληρο toolchain για να χτιστεί.
FROM node:24-slim

# Το HLS βγαίνει από ffmpeg remux, δες config.json -> hls.ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Χωριστά από τον υπόλοιπο κώδικα: το layer των dependencies μένει cached όσο δεν
# αλλάζουν. `ci` και όχι `install`: δύο builds σε διαφορετικές μέρες πρέπει να
# δίνουν τις ίδιες εκδόσεις — αλλιώς ένα σπασμένο minor release τρίτου πακέτου
# εμφανίζεται μόνο στα καινούρια μηχανήματα.
# Το context είναι η ρίζα του monorepo, όχι το apps/stream: με npm workspaces
# υπάρχει ένα package-lock.json και ζει στη ρίζα — ένα context μέσα στο
# apps/stream δεν θα το έβλεπε καθόλου.
COPY package.json package-lock.json ./
COPY apps/stream/package.json apps/stream/
RUN npm ci --omit=dev -w apps/stream

COPY apps/stream/ apps/stream/
WORKDIR /app/apps/stream

EXPOSE 1935 8000 8001

CMD ["node", "app.js"]
