.PHONY: install install-kohaku release-gate check test build

install:
	node scripts/install.mjs

install-kohaku:
	node scripts/install-kohaku.mjs

release-gate:
	node scripts/release-gate.mjs $(ARGS)

check:
	npm run check

test:
	npm test

build:
	npm run build
