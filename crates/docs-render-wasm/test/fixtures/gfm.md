---
title: GFM tour
order: 3
---

# Title with `code` and *emphasis*

Some *em*, **strong**, ~~del~~ and an autolink https://example.com.

## Tables

| left | centre | right |
|:-----|:------:|------:|
| 1    | 2      | 3     |

## Lists

- [x] done
- [ ] todo
  1. nested
  2. ordered

> A quote with a [relative link](../intro.md#start) and [another](phase-2.md?x=1).

```rust
fn main() { println!("<hi>"); }
```

Hi[^1] and an image ![alt](pic.png "Title").

[ref]: https://example.com/ref
See [the ref][ref].

<details><summary>Raw HTML</summary>

<script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">bad</a>

</details>

### Third level heading

[^1]: A footnote.
