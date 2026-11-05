#!/usr/bin/env python3
"""Build the print-ready Arabic leave-behind handed to the doctor (A5, one page).

Not site code and not a runtime dependency: this is a one-off tool. It needs
fpdf2 (which bundles HarfBuzz shaping), plus fonttools/brotli to convert the
repository's own woff2 webfonts to TrueType first, so the PDF is self-contained
and uses the clinic's typeface instead of whatever the reader happens to have.

    .venv-tools/bin/python pitch/build-sheet.py

Why shaping matters here: Almarai's subset ships the Arabic *presentation forms*
and a GSUB table, not a pre-shaped glyph run per codepoint. A reshaper that writes
presentation-form codepoints therefore produces characters the subset does not
map, and the page printed disconnected letters. HarfBuzz applies the font's own
init/medi/fina/liga features, which is the only correct path.
"""
import pathlib
import sys

from fpdf import FPDF

FONT_DIR = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path('/tmp/ttf')
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'pitch/celia-kids-doctor-sheet.pdf')

MM = 1
PAGE_W, PAGE_H = 148, 210
MARGIN = 13
CONTENT_W = PAGE_W - 2 * MARGIN

INK = (18, 49, 43)
MUTED = (92, 111, 106)
ACCENT = (15, 122, 95)
LINE = (215, 227, 222)
WASH = (242, 247, 245)
WHITE = (255, 255, 255)

# Numbers are Arabic-Indic in the copy, as the site does; Latin stays for the brand.
BULLETS = [
    ('موافقتك هي التأكيد', 'لا يُنشأ أي حدث في التقويم إلا بعد موافقة بشرية.'),
    ('لا حجز مزدوج', 'الوقت المحجوز يُرفض فورًا، والتقويم هو مرجع التوفّر.'),
    ('الإلغاء يُعيد الوقت', 'يُحذف الحدث ويصبح الوقت متاحًا في اللحظة نفسها.'),
    ('لا بيانات طبية', 'اسم ولي الأمر ورقم التواصل ووقت مفضل — لا أكثر.'),
    ('التقويم بلا تفاصيل', 'الحدث يحمل الرقم المرجعي فقط، لا اسمًا ولا تشخيصًا.'),
    ('أنت تدير العيادة', 'الدوام والزيارات والأسعار ورقم العيادة من شاشة الإعدادات.'),
]


class Sheet(FPDF):
    def header(self):
        pass

    def footer(self):
        pass


def build() -> pathlib.Path:
    pdf = Sheet(orientation='P', unit='mm', format=(PAGE_W, PAGE_H))
    pdf.set_auto_page_break(False)
    pdf.set_margins(MARGIN, MARGIN, MARGIN)
    pdf.add_font('Almarai', fname=str(FONT_DIR / 'almarai-400-arabic.ttf'))
    pdf.add_font('AlmaraiB', fname=str(FONT_DIR / 'almarai-700-arabic.ttf'))
    pdf.add_font('AlmaraiX', fname=str(FONT_DIR / 'almarai-800-arabic.ttf'))
    # Almarai ships Arabic only (no 'K'), so the brand line and the year need Plex Latin.
    pdf.add_font('Plex', fname=str(FONT_DIR / 'plex-latin-600.ttf'))
    pdf.add_page()
    pdf.set_text_shaping(True)

    # ---- header band ---------------------------------------------------------
    pdf.set_fill_color(*ACCENT)
    pdf.rect(0, 0, PAGE_W, 30, style='F')
    pdf.set_text_color(*WHITE)
    pdf.set_font('Plex', size=19)
    pdf.set_xy(MARGIN, 7)
    pdf.cell(CONTENT_W, 6, 'Celia Kids', align='R')
    pdf.set_font('Almarai', size=9.5)
    pdf.set_text_color(207, 233, 224)
    pdf.set_xy(MARGIN, 17)
    pdf.cell(CONTENT_W, 5, 'حجز مواعيد أطفال · الطلب لا يعني التأكيد', align='R')

    # ---- promise -------------------------------------------------------------
    y = 38
    pdf.set_text_color(*INK)
    pdf.set_font('AlmaraiB', size=12.5)
    pdf.set_xy(MARGIN, y)
    pdf.multi_cell(CONTENT_W, 7.4, 'ولي الأمر يطلب موعدًا في دقيقة، بلا تطبيق ولا تسجيل.',
                   align='R', new_x='LMARGIN', new_y='NEXT')

    pdf.set_font('AlmaraiB', size=12.5)
    pdf.set_text_color(*ACCENT)
    pdf.set_x(MARGIN)
    pdf.multi_cell(CONTENT_W, 7.4, 'الطلب لا يحجز الوقت. موافقة العيادة وحدها تفعل.',
                   align='R', new_x='LMARGIN', new_y='NEXT')

    # ---- guarantees card -----------------------------------------------------
    card_top = pdf.get_y() + 4
    card_h = 4 + len(BULLETS) * 11.4 + 2
    pdf.set_fill_color(*WASH)
    pdf.rect(MARGIN, card_top, CONTENT_W, card_h, style='F', round_corners=True, corner_radius=3)

    cursor = card_top + 6
    for title, detail in BULLETS:
        pdf.set_fill_color(*ACCENT)
        pdf.circle(PAGE_W - MARGIN - 4, cursor + 1.4, 1.3, style='F')
        pdf.set_text_color(*INK)
        pdf.set_font('AlmaraiB', size=9.6)
        pdf.set_xy(MARGIN + 4, cursor)
        pdf.cell(CONTENT_W - 10, 5, title, align='R')
        pdf.set_text_color(*MUTED)
        pdf.set_font('Almarai', size=8.7)
        pdf.set_xy(MARGIN + 4, cursor + 5.1)
        pdf.multi_cell(CONTENT_W - 10, 4.4, detail, align='R', new_x='LMARGIN', new_y='NEXT')
        cursor += 11.4

    # ---- what it deliberately does not do ------------------------------------
    y = card_top + card_h + 8
    pdf.set_draw_color(*LINE)
    pdf.set_line_width(0.3)
    pdf.line(MARGIN, y - 4, PAGE_W - MARGIN, y - 4)
    pdf.set_text_color(*INK)
    pdf.set_font('AlmaraiB', size=9.6)
    pdf.set_xy(MARGIN, y)
    pdf.cell(CONTENT_W, 5, 'ما لا يفعله — بصراحة', align='R')
    pdf.set_text_color(*MUTED)
    pdf.set_font('Almarai', size=8.7)
    pdf.set_xy(MARGIN, y + 6)
    pdf.multi_cell(CONTENT_W, 4.6,
                   'لا تطبيق ولا دفع إلكتروني. لا رسائل واتساب تلقائية — الوضع مطفأ حتى تقرر العيادة. '
                   'ولا نصائح طبية ولا تشخيص: المساعد الاختياري يرفض الأسئلة الطبية بالتصميم.',
                   align='R', new_x='LMARGIN', new_y='NEXT')

    # ---- next step -----------------------------------------------------------
    y = max(pdf.get_y() + 5, 156)
    pdf.set_draw_color(*ACCENT)
    pdf.set_line_width(0.5)
    pdf.rect(MARGIN, y, CONTENT_W, 18, style='D', round_corners=True, corner_radius=2.5)
    pdf.set_text_color(*ACCENT)
    pdf.set_font('AlmaraiB', size=9)
    pdf.set_xy(MARGIN + 5, y + 4)
    pdf.cell(CONTENT_W - 10, 4.5, 'الخطوة المقترحة', align='R')
    pdf.set_text_color(*INK)
    pdf.set_font('Almarai', size=9.4)
    pdf.set_xy(MARGIN + 5, y + 9.5)
    pdf.cell(CONTENT_W - 10, 5, 'أسبوع واحد على بيانات تجريبية، ثم قرار.', align='R')

    # ---- footer --------------------------------------------------------------
    pdf.set_draw_color(*LINE)
    pdf.set_line_width(0.3)
    pdf.line(MARGIN, PAGE_H - 15, PAGE_W - MARGIN, PAGE_H - 15)
    pdf.set_text_color(*MUTED)
    pdf.set_font('Almarai', size=7.2)
    pdf.set_xy(MARGIN, PAGE_H - 12)
    pdf.cell(CONTENT_W - 12, 4, 'الصفحة تعمل على الموبايل بلا تطبيق · بيانات التواصل فقط', align='R')
    pdf.set_xy(PAGE_W - MARGIN - 12, PAGE_H - 12)
    pdf.set_font('Plex', size=7.2)
    pdf.cell(12, 4, '2026', align='L')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(OUT))
    return OUT


if __name__ == '__main__':
    path = build()
    print(f'written {path} ({path.stat().st_size} bytes)')
