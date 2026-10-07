# XSS Boundary Fixture

The markdown pipeline sanitizes authored HTML before it reaches the DOM. This
document embeds hostile payloads that the DOMPurify pass must strip:

<script>alert('xss')</script>

<img src="x" onerror="alert('xss')">

[javascript link](javascript:alert('xss'))

Ordinary prose survives; the payloads above do not.
