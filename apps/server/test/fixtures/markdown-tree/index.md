# Fixture Docs Index

A GFM document exercising the markdown pipeline: a table, a task list, and a
fenced, highlightable code block. See the [image demo](images.md) for a relative
image rendered through the raw route.

## Status table

| Service | Port | Enabled |
| ------- | ---- | ------- |
| web     | 8080 | yes     |
| db      | 5432 | no      |

## Checklist

- [x] Boot the server
- [ ] Wire the reverse proxy

## Example

```js
export function greet(name) {
  return `hello, ${name}`;
}
```
