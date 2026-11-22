# Self-signed certificates

← [Documentation](README.md)

If Paperless-ngx or your AI server uses a certificate from your own CA, mount the CA certificate and point Node.js to it:

```yaml
    environment:
      - NODE_EXTRA_CA_CERTS=/certs/my-ca.pem
    volumes:
      - ./my-ca.pem:/certs/my-ca.pem:ro
```

As a last resort, `NODE_TLS_REJECT_UNAUTHORIZED=0` turns certificate checks off completely. ⚠️ This applies to **every** connection of Paperless-AI – including the one carrying your OpenAI/Anthropic API key – so anybody in the network path could read and change the traffic. Only use it for testing in a trusted network.
