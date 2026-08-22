"""BlurHash encoder: a ~28-character string that decodes to a blurred preview.

Vendored rather than pip-installed: the whole algorithm is a cosine transform
over a handful of basis functions, it is about a hundred lines, it needs
nothing outside the stdlib, and this repo is headed for a public release where
every added dependency is a thing someone else has to trust. The published
reference implementation (woltapp/blurhash, C/encode.c + C/common.h) is
transcribed below step for step, including its exact rounding and clamping,
and the test vectors are strings that reference produced when compiled and fed
the identical pixel buffer.

The point of the string: a photo bubble can paint the real image's colours and
shape the instant the message arrives, instead of a grey rectangle, and it
costs ~28 bytes on the wire instead of a second network round trip.

One thing to know before comparing output with anything else: the same project
ships a TypeScript port whose AC scale takes the largest signed component where
the C takes the largest magnitude (no fabs). On a picture whose components all
trend negative the two therefore disagree, and every other port follows the C.
This follows the C. Both remain readable by every decoder, which takes the
scale from the string itself.

Stdlib only on purpose. This module rides in both Docker images through
``web/__init__``, and pixels arrive as plain bytes so nothing here needs
Pillow either.
"""

from __future__ import annotations

import math

# base83 is blurhash's own alphabet: url-safe, html-safe, and dense enough that
# a 4x3 hash fits in 28 characters
_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"


def _base83(value: int, length: int) -> str:
    return "".join(
        _ALPHABET[(value // 83 ** (length - i)) % 83] for i in range(1, length + 1)
    )


def _srgb_to_linear(value: int) -> float:
    v = value / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


# every pixel channel is one of 256 values, so the gamma curve is a table
# lookup rather than a pow() per channel per basis function
_LINEAR = [_srgb_to_linear(i) for i in range(256)]


def _linear_to_srgb(value: float) -> int:
    v = max(0.0, min(1.0, value))
    if v <= 0.0031308:
        return int(v * 12.92 * 255 + 0.5)
    return int((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5)


def _sign_pow(value: float, exp: float) -> float:
    return math.copysign(abs(value) ** exp, value)


def _encode_dc(r: float, g: float, b: float) -> int:
    return (_linear_to_srgb(r) << 16) + (_linear_to_srgb(g) << 8) + _linear_to_srgb(b)


def _quantise_ac(value: float, maximum: float) -> int:
    # the reference stores each AC channel in 19 steps around a zero of 9,
    # square-rooted so small differences get more of the range
    return int(max(0, min(18, math.floor(_sign_pow(value / maximum, 0.5) * 9 + 9.5))))


def _encode_ac(r: float, g: float, b: float, maximum: float) -> int:
    return (
        _quantise_ac(r, maximum) * 19 * 19
        + _quantise_ac(g, maximum) * 19
        + _quantise_ac(b, maximum)
    )


def encode(
    pixels: bytes, width: int, height: int, x_components: int = 4, y_components: int = 3
) -> str:
    """BlurHash for packed RGB bytes (3 per pixel, rows top to bottom, no row
    padding, which is exactly what ``Image.tobytes()`` hands back for an RGB
    image).

    4x3 components is the reference default and what blurhash.com's own
    examples use: 28 characters, enough structure to read as "the photo" at a
    glance. More components would sharpen the preview and lengthen the string,
    which is the opposite of the trade this is here for.

    Cost is O(components x pixels), so callers downscale first. A blurhash of a
    32px-wide copy of a photo and of the photo itself agree to within a
    character or two, because both are throwing away everything but the lowest
    frequencies anyway.
    """
    if not 1 <= x_components <= 9 or not 1 <= y_components <= 9:
        raise ValueError("blurhash components must be between 1 and 9")
    if width <= 0 or height <= 0 or len(pixels) < width * height * 3:
        raise ValueError("pixel buffer is smaller than width x height x 3")

    # the cosines depend only on (component, coordinate), so they are computed
    # once here instead of width x height times inside each component's loop
    cos_x = [[math.cos(math.pi * i * x / width) for x in range(width)]
             for i in range(x_components)]
    cos_y = [[math.cos(math.pi * j * y / height) for y in range(height)]
             for j in range(y_components)]

    factors: list[tuple[float, float, float]] = []
    for j in range(y_components):
        for i in range(x_components):
            # the DC term is the plain average; every AC term is doubled
            # because it only covers half a cosine period
            normalisation = 1.0 if (i == 0 and j == 0) else 2.0
            cxi, cyj = cos_x[i], cos_y[j]
            r = g = b = 0.0
            for y in range(height):
                basis_y = cyj[y]
                row = y * width * 3
                for x in range(width):
                    basis = basis_y * cxi[x]
                    p = row + x * 3
                    r += basis * _LINEAR[pixels[p]]
                    g += basis * _LINEAR[pixels[p + 1]]
                    b += basis * _LINEAR[pixels[p + 2]]
            scale = normalisation / (width * height)
            factors.append((r * scale, g * scale, b * scale))

    dc, ac = factors[0], factors[1:]

    out = _base83((x_components - 1) + (y_components - 1) * 9, 1)
    if ac:
        # one shared scale for every AC term, quantised into the string so the
        # decoder can undo it; a flat image has no AC range at all and takes
        # the 0 branch
        actual_max = max(max(abs(c) for c in f) for f in ac)
        quantised_max = int(max(0, min(82, math.floor(actual_max * 166 - 0.5))))
        maximum = (quantised_max + 1) / 166
        out += _base83(quantised_max, 1)
    else:
        maximum = 1.0
        out += _base83(0, 1)
    out += _base83(_encode_dc(*dc), 4)
    for f in ac:
        out += _base83(_encode_ac(*f, maximum), 2)
    return out
