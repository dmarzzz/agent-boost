.PHONY: install install-kohaku check test build

install:
	node scripts/install.mjs

install-kohaku:
	node scripts/install-kohaku.mjs

check:
	npm run check

test:
	npm test

build:
	npm run build
