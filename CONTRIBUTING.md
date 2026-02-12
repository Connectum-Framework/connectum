# Contributing to Connectum

Thank you for your interest in Connectum! We welcome contributions from the community.

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [How Can I Help?](#how-can-i-help)
3. [Development Process](#development-process)
4. [Pull Request Process](#pull-request-process)
5. [Code Style](#code-style)
6. [Commit Messages](#commit-messages)
7. [Testing](#testing)
8. [Documentation](#documentation)
9. [Community](#community)

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

## How Can I Help?

### Reporting Bugs

If you found a bug:

1. **Check existing issues** - the problem may already be known
2. **Create a detailed issue** with:
   - Problem description
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Node.js version, package versions, OS
   - Minimal reproducible example (if possible)

### Suggesting Enhancements

Enhancement ideas are welcome:

1. **Check existing issues and ADRs** - it may have already been discussed
2. **Create an enhancement issue** with:
   - Proposal description
   - Use cases
   - API/usage examples
   - Alternatives and trade-offs

### Contributing Code

1. **Find an issue to work on** - check issues labeled `good first issue` or `help wanted`
2. **Discuss before starting** - especially for large changes
3. **Follow the development process** - see below

## Development Process

### Prerequisites

- **Node.js**: ≥25.2.0 (for stable type stripping)
- **pnpm**: ≥10.0.0
- **Git**: Latest version
- **protoc**: Latest version (for proto generation)

### Setup Development Environment

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/connectum.git
cd connectum

# 3. Add upstream remote
git remote add upstream https://github.com/original-org/connectum.git

# 4. Install dependencies
pnpm install

# 5. Verify setup
pnpm typecheck
pnpm lint
pnpm test
```

### Development Workflow

```bash
# 1. Create feature branch
git checkout -b feature/my-feature main

# 2. Make changes
# - Edit code
# - Add tests
# - Update documentation

# 3. Run checks locally
pnpm typecheck      # Type checking
pnpm lint           # Linting
pnpm format         # Auto-format code
pnpm test           # Run tests
pnpm test:unit      # Unit tests only
pnpm test:integration  # Integration tests only

# 4. Commit changes
git add .
git commit -m "feat: add new feature"

# 5. Push to your fork
git push origin feature/my-feature

# 6. Create Pull Request on GitHub
```

### Keeping Fork Updated

```bash
# Fetch upstream changes
git fetch upstream

# Merge upstream main into your local main
git checkout main
git merge upstream/main

# Rebase your feature branch
git checkout feature/my-feature
git rebase main

# Force push to your fork (if already pushed)
git push origin feature/my-feature --force-with-lease
```

## Pull Request Process

### Before Creating PR

1. **Update from main** - rebase your branch on latest main
2. **Run all checks** - typecheck, lint, test
3. **Update documentation** - README, JSDoc, guides
4. **Add tests** - for new functionality
5. **Update CHANGELOG** - using Changesets

### Creating PR

1. **Use clear title** - follow [Conventional Commits](#commit-messages)
2. **Fill PR template** - provide context, testing notes
3. **Link related issues** - use `Closes #123` or `Relates to #456`
4. **Request reviewers** - tag relevant maintainers

### PR Title Format

```
<type>(<scope>): <description>

Examples:
feat(runner): add custom protocol support
fix(database): correct WAL checkpoint timing
docs(readme): update installation instructions
chore(deps): upgrade @connectrpc/connect to v2.0
```

### PR Description Template

```markdown
## Description

Brief description of what this PR does.

## Motivation and Context

Why is this change needed? What problem does it solve?

Closes #123

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing

How has this been tested?

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Checklist

- [ ] My code follows the code style of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings or errors
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have updated the CHANGELOG using Changesets
```

### Review Process

1. **Automated checks** - CI must pass (typecheck, lint, test)
2. **Code review** - at least 1 approval from a maintainer
3. **Address feedback** - respond to review comments, make changes
4. **Final approval** - maintainer approves and merges

## Code Style

### TypeScript Conventions

We use **Biome** for linting and formatting. Configuration is in `biome.json`.

#### Key Rules

1. **Native TypeScript** - using stable type stripping (Node.js 25.2.0+)
   - ❌ No `enum` - use `const` objects with `as const`
   - ❌ No `namespace` with runtime code
   - ❌ No parameter properties
   - ✅ Explicit `import type` required
   - ✅ `.js` extensions in import paths

2. **Import Order**
   ```typescript
   // 1. External imports
   import { createConnectRouter } from "@connectrpc/connect";

   // 2. Internal workspace imports
   import { retry } from "cockatiel";

   // 3. Type imports
   import type { RunnerOptions } from "./types.js";

   // 4. Relative imports
   import { myFunction } from "./utils.js";
   ```

3. **Naming Conventions**
   - **PascalCase**: Classes, Types, Interfaces, Enums (const objects)
   - **camelCase**: Functions, variables, parameters
   - **UPPER_SNAKE_CASE**: Constants
   - **kebab-case**: File names (except index.ts, types.ts)

4. **Named Parameters** - preferred for options:
   ```typescript
   // ✅ Good
   async function sleep(options: {
     interval: number;
     multiplier?: number;
   }): Promise<void>

   // ❌ Avoid
   async function sleep(interval: number, multiplier?: number): Promise<void>
   ```

5. **JSDoc Comments** - for public API:
   ```typescript
   /**
    * Retry function with exponential backoff.
    *
    * @param options - Retry configuration
    * @returns Promise resolving to function result
    * @throws {RetryExhaustedError} When max retries exceeded
    *
    * @example
    * ```typescript
    * const result = await retry({
    *   fn: async () => fetchData(),
    *   maxRetries: 3,
    * });
    * ```
    */
   export async function retry<T>(options: RetryOptions): Promise<T>
   ```

### Running Linter

```bash
# Check code style
pnpm lint

# Auto-fix issues
pnpm format

# Check specific package
pnpm --filter @connectum/core lint
```

Full Code Style Guide: [docs/development/code-style.md](./docs/development/code-style.md)

## Commit Messages

We use the **Conventional Commits** specification.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring (no feat/fix)
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (deps, config, etc.)
- `ci`: CI/CD changes
- `build`: Build system changes

### Scopes

- `runner` - @connectum/core
- `observability` - @connectum/otel
- `interceptors` - @connectum/interceptors
- `testing` - @connectum/testing
- `docs` - Documentation
- `deps` - Dependencies
- `ci` - CI/CD

### Examples

```
feat(runner): add custom protocol support

Add ability to register custom protocols alongside
health check and reflection.

Closes #123

---

docs(readme): update installation instructions

Add missing peer dependencies and Node.js version requirement.

---

chore(deps): upgrade @connectrpc/connect to v2.0.0

BREAKING CHANGE: ConnectRPC v2 has new API.
See migration guide for details.
```

### Breaking Changes

For breaking changes:

```
feat(runner)!: change RunnerOptions API

BREAKING CHANGE: RunnerOptions now requires named parameters.

Before:
const server = await Runner(services, options);

After:
const server = await Runner({ services, ...options });
```

## Testing

### Running Tests

```bash
# All tests
pnpm test

# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# Specific package
pnpm --filter @connectum/core test

# With coverage
pnpm test -- --coverage

# Watch mode
pnpm test -- --watch
```

### Writing Tests

We use the **Node.js native test runner** (no Jest, Mocha, etc.).

#### Test Structure

```typescript
// myFunction.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { myFunction } from "./myFunction.js";

describe("myFunction", () => {
  let context: TestContext;

  beforeEach(() => {
    context = setupTestContext();
  });

  afterEach(() => {
    cleanupTestContext(context);
  });

  it("should handle valid input", () => {
    const result = myFunction("valid");
    assert.strictEqual(result, "expected");
  });

  it("should throw on invalid input", () => {
    assert.throws(
      () => myFunction("invalid"),
      { message: "Invalid input" }
    );
  });

  it("should handle async operations", async () => {
    const result = await myFunction("async");
    assert.ok(result);
  });
});
```

#### Test Naming

- **Describe block**: Function/class name
- **Test case**: `should [expected behavior]`
- **File name**: `*.test.ts` next to the source file

#### Assertions

We use `node:assert`:

```typescript
import assert from "node:assert";

// Equality
assert.strictEqual(actual, expected);
assert.deepStrictEqual(actualObject, expectedObject);

// Truthiness
assert.ok(value);
assert.equal(value, true);

// Exceptions
assert.throws(() => fn(), Error);
assert.rejects(async () => asyncFn(), Error);

// Type checks
assert.ok(value instanceof MyClass);
assert.strictEqual(typeof value, "string");
```

### Test Coverage

Minimum coverage:

- **Unit tests**: ≥80% coverage
- **Integration tests**: Critical paths covered
- **Public API**: 100% coverage

## Documentation

### Types of Documentation

1. **README files** - Package overviews, quick start
2. **JSDoc comments** - Inline API documentation
3. **Guides** - `docs/guides/` - How-to guides, best practices
4. **Architecture docs** - `docs/architecture/` - ADRs, design docs
5. **API Reference** - Generated from JSDoc
6. **Examples** - `packages/examples/` - Working code examples

### Writing Documentation

#### README Template

See existing package READMEs for a template.

Key sections:
- Title and description
- Installation
- Quick start
- Main exports/API
- Examples
- Links to detailed docs

#### JSDoc Style

```typescript
/**
 * Brief one-line description.
 *
 * Detailed description with multiple paragraphs if needed.
 * Explain what the function does, when to use it, etc.
 *
 * @param options - Configuration options
 * @param options.maxRetries - Maximum retry attempts (default: 3)
 * @param options.initialDelay - Initial delay in ms (default: 100)
 * @returns Promise resolving to operation result
 * @throws {RetryExhaustedError} When max retries exceeded
 *
 * @example
 * Basic usage:
 * ```typescript
 * const result = await retry({
 *   fn: async () => fetchData(),
 *   maxRetries: 5,
 * });
 * ```
 *
 * @example
 * With custom backoff:
 * ```typescript
 * const result = await retry({
 *   fn: async () => fetchData(),
 *   initialDelay: 500,
 *   multiplier: 2,
 * });
 * ```
 *
 * @see {@link ExponentialBackoff} for backoff configuration
 * @since 1.0.0
 */
export async function retry<T>(options: RetryOptions): Promise<T>
```

#### Updating Documentation

When changing code:

1. **Update JSDoc** - for changed functions/types
2. **Update README** - if the public API changed
3. **Update guides** - if the usage pattern changed
4. **Add examples** - for new features
5. **Create ADR** - for significant architectural changes

### Documentation Review

Documentation changes:

- Must be clear and concise
- Must include working examples
- Must be accurate (tested examples)
- Must follow consistent style

## Community

### Getting Help

- **GitHub Discussions** - Questions, ideas, discussions
- **GitHub Issues** - Bugs, feature requests
- **Pull Requests** - Code contributions

### Communication Guidelines

- **Be respectful** - Follow Code of Conduct
- **Be clear** - Provide context, examples
- **Be patient** - Maintainers volunteer their time
- **Search first** - Check existing issues/discussions

## License

By contributing, you agree that your contributions will be licensed under the project's MIT License.

---

**Thank you for contributing to Connectum!**

If you have questions about the contribution process, create a discussion in GitHub Discussions.
