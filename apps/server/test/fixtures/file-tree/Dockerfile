FROM alpine:3.20

RUN apk add --no-cache curl

WORKDIR /app
COPY . .

EXPOSE 8080
CMD ["./run.sh"]
