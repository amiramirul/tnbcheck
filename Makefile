.PHONY: up down restart

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose build app local-api
	docker compose up -d --no-deps --force-recreate app local-api
