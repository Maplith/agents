# Contributing

Thank you for helping. Issues and pull requests are welcome.

For a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Before you start

The relay is small on purpose, because it holds the token that starts your agent:

- It uses Node.js alone. A change that adds a dependency will not be merged.
- The text it passes on is signal ids and whole numbers, validated one by one.
  Nothing from a wake-up's body may reach it any other way.
- Every change comes with a test that fails without it.

For anything larger than a fix, open an issue first.

## Develop

```sh
npm test      # every test; nothing leaves your machine
```

Sign off every commit (`git commit -s`): the pull request check refuses a commit
without it.
