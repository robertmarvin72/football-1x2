# 1X2 Football Predictor, Local JS Prototype

Þetta er V1 proof-of-concept fyrir local JavaScript app sem spáir 1X2 úrslitum fyrir fótboltaleiki.

## Keyrsla

Opnaðu `index.html` beint í browser.

Eða keyrðu local server:

```bash
npx serve .
```

## Hvað er inni

- `index.html`, local UI
- `style.css`, útlit
- `app.js`, demo data + prediction engine

## Hvað módelið notar núna

- Recent form
- Home/away strength
- Goals for / against
- League position
- Rest days
- Draw tendency

## Næsta skref

1. Skipta demoData út fyrir API gögn.
2. Vista historical fixtures í JSON.
3. Bæta við backtesting.
4. Bera prediction probability saman við bookmaker odds.
5. Stilla vægi eftir raunárangri.

## API hugmynd

Búa til adapter þannig að appið þurfi bara þetta shape:

```js
{
  teams: [...],
  fixtures: [...]
}
```

Þá er sama hvort gögnin koma úr football-data.org, API-Football, Sportmonks eða eigin server.
