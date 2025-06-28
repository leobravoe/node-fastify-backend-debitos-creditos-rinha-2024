FROM node:18

# Install PostgreSQL client
RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Make wait-for-it script executable
RUN chmod +x wait-for-it.sh

EXPOSE 3000

# Use wait-for-it script to ensure PostgreSQL is ready
CMD ["./wait-for-it.sh", "postgres", "npm", "run", "start"]
