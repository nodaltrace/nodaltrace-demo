"""Números e datas em texto, no formato americano (en-US, a demo é em inglês), para as evidências, os relatórios e o PDF."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

#: Horário de Brasília (sem horário de verão desde 2019).
BRASILIA = timezone(timedelta(hours=-3))
#: Meses abreviados em inglês, fixos (o `%b` depende do locale do sistema).
MESES = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def num(x: float, casas: int = 1) -> str:
    """1234.56 → '1,234.6'."""
    return f'{x:,.{casas}f}'


def ha(x: float) -> str:
    """1234.56 → '1,234.6 ha'."""
    return f'{num(x)} ha'


def pct(f: float) -> str:
    """0.624 → '62.4%'."""
    return f'{f * 100:.1f}%'


def pct_curto(f: float) -> str:
    """Como `pct`, mas sem casa decimal nos extremos: '100%', '0%', '62.4%'."""
    return f'{f * 100:.0f}%' if f >= 0.995 or f <= 0.005 else pct(f)


def data(d: date | None) -> str:
    """2026-10-21 → 'Oct 21, 2026'."""
    return f'{MESES[d.month - 1]} {d.day}, {d.year}' if d else 'date not reported'


def mes(d: date) -> str:
    """2025-10-14 → 'Oct 2025'."""
    return f'{MESES[d.month - 1]} {d.year}'


def dia(instante: datetime) -> date:
    """O dia de um instante no horário de Brasília (uma carga às 23h de Brasília é do dia, não do seguinte em UTC)."""
    return instante.astimezone(BRASILIA).date()
