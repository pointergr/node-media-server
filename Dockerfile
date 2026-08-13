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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 1935 8000 8001

CMD ["node", "app.js"]
