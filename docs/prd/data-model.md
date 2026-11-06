# نموذج البيانات — ٢٢ كيانًا

> مكتوب ليصلح على Sheets اليوم وعلى قاعدة SQL غدًا دون إعادة تصميم.
> **العمود `id` في كل جدول** نصّي (لا رقم تسلسلي) لتسهيل الترحيل والدمج.
> **كل جدول يحمل `clinic_id`** حتى لو كان العزل فيزيائيًا (ملف لكل عيادة).
> التصنيف: `A` عام · `B` شخصي · `C` صحي/حساس (يستلزم بوابة `compliance-egypt.md`).

---

## 1 · الكيانات الأساسية (الموجود اليوم = Sheet `Requests`)

### 1.1 `clinic` — العيادة (جديد)
| الحقل | النوع | تصنيف | ملاحظة |
| --- | --- | --- | --- |
| id | text | A | `clinic_001` |
| name, name_en | text | A | من الإعدادات |
| phone, whatsapp | text | A | الهاتف المعلن |
| license_no | text | A | ترخيص المنشأة |
| timezone | text | A | `Africa/Cairo` (ثابت حاليًا في `Code.gs`) |
| created_at, status | ts/text | A | `active|suspended` |

### 1.2 `branch` — الفرع (جديد)
| id · clinic_id · name · address · geo_lat · geo_lng · map_url · phone · is_default |
| --- |
| `map_url` رابط خرائط جاهز (بلا API مدفوع). `geo_*` اختياري—بدونه يبقى «عنوان + اتجاهات». |

### 1.3 `staff` — الفريق (جديد، يستبدل الـPIN الواحد)
| id · clinic_id · branch_id · role · full_name · email · phone · pin_hash · pin_salt · active · last_login_at · failed_attempts · locked_until |
| --- |
| `role` ∈ `DOCTOR|RECEPTION|CLINIC_ADMIN`. `pin_hash` = SHA-256 + salt (نمط `Settings.gs` الحالي). لا يوجد نص صريح إطلاقًا. |

**المُنفَّذ اليوم (ADR-0007):** ورقة `Staff` بأعمدة `id · name · role · pinHash · active · createdAt` وحدها — بلا `clinic_id`/`branch_id`/`email`/`phone`/`last_login_at`/`failed_attempts` لأن العيادة واحدة والعدّاد ما زال مشتركًا. `pinHash` بصمة SHA-256 **بلا salt** حتى الآن (البصمة تُقارن بمقارنة ثابتة الزمن)، والجلسة في `Script Properties` بمفتاح `CK_SESSION_<token>` وصلاحية ٨ ساعات. إضافة الأعمدة الباقية عمل موجات متعددة العيادات، لا هذه الموجة.

### 1.4 `doctor` — الطبيب (جديد)
| id · clinic_id · staff_id · display_name · title · subspecialty · license_no · bio · photo_url · years_experience · languages · accepts_online |
| --- |
| `license_no` يُعرض كشارة «مُتحقَّق» فقط إذا عبّأته العيادة (نمط قائم في `Settings.gs`). |

### 1.5 `doctor_service` — خدمة وسعر (جديد)
| id · clinic_id · doctor_id · branch_id · label · duration_min · price · currency · active |
| --- |
| **السعر اليوم غير موجود في الكود إطلاقًا.** يُضاف هنا ويُقرأ منه في الواجهة؛ لا يُكتب في HTML. |

### 1.6 `availability_rule` — قاعدة الدوام (جديد، يعمّم الإعدادات الحالية)
| id · clinic_id · doctor_id · branch_id · weekday(0–6) · start_time · end_time · slot_min · break_start · break_end · valid_from · valid_to |
| --- |
| اليوم: `WORK_DAYS`/`WORK_START`/`WORK_END`/`SLOT_MINUTES` في Script Properties لعيادة واحدة. هذا الجدول يجعلها لكل طبيب/فرع/فترة. |

### 1.7 `time_off` — إجازة/إغلاق (موجود كـSheet `Closures`)
| day · start · end · label · created_at → يُضاف `doctor_id`, `branch_id`, `reason_code` |
| --- |

### 1.8 `patient` — المريض (جديد، تصنيف B)
| id · clinic_id · full_name · birth_date · sex · guardian_id · phone · national_id(اختياري، مشفّر) · consent_version · created_at · status |
| --- |
| **لا حقل طبي واحد هنا.** البيانات الصحية في جدول منفصل (§1.9) لتسهيل الصلاحيات والحذف المستقل. |

### 1.9 `patient_medical` — الملف الطبي (جديد، تصنيف C — **معطّل افتراضيًا**)
| patient_id · blood_type · allergies · chronic_conditions · notes · updated_by · updated_at |
| --- |
| جدول منفصل تمامًا؛ لا يُستعلم عنه إلا بمفتاح صلاحية ١٣. في التنفيذ الحالي: `DisabledStore`. |

### 1.10 `guardian` — ولي الأمر (جديد)
| id · clinic_id · full_name · phone · email · relation · consent_flags · created_at |
| --- |
| الحساب العائلي = ولي أمر واحد + عدة مرضى. لا حساب منفصل لكل طفل (وهو ما طلبته في الوحدة ١١). |

### 1.11 `booking` — الحجز (موجود كـSheet `Requests` — يُوسَّع)
| الحقل | اليوم | المطلوب |
| --- | --- | --- |
| reference | ✅ | يبقى |
| created_at, updated_at | ✅ | يبقى |
| status | ✅ ٦ حالات | تُضاف `CHECKED_IN`, `IN_CONSULTATION`, `NO_SHOW` |
| visit_type | ✅ نص | يُستبدل بـ `service_id` (مع بقاء النص للعرض) |
| guardian_name, phone | ✅ | يتحوّلان إلى `patient_id` + `guardian_id` مع بقاء اللقطة النصية |
| day, time | ✅ | يُضاف `duration_min` (مأخوذ لحظة الحجز، لا يُعاد حسابه) |
| event_id | ✅ | يبقى |
| consent, slot_verified | ✅ | يبقيان |
| — | ❌ | `clinic_id`, `branch_id`, `doctor_id`, `service_id`, `price_agreed`, `source` (`web|phone|walkin|assistant`), `queue_no`, `payment_id`, `no_show_reason` |

> **قاعدة لقطة (snapshot):** تُحفظ نسخة نصية من الاسم والهاتف والسعر لحظة الحجز، حتى لو تغيّر
> ملف المريض لاحقًا. هذا يمنع «تغيّر الفاتورة بعد إصدارها».

### 1.12 `booking_status_history` (جديد)
| booking_id · from_status · to_status · actor_staff_id · at · reason |
| --- |
| اليوم: `Audit` يجمع كل شيء. الفصل يسمح بعرض «رحلة الطلب» للمريض بلا كشف أحداث إدارية. |

### 1.13 `queue_ticket` — الدور (جديد)
| id · clinic_id · booking_id · doctor_id · branch_id · ticket_no · stage · issued_at · called_at · entered_at · finished_at · priority · source(`booked|walkin`) · estimated_wait_min |
| --- |
| `stage` ∈ `WAITING|CALLED|IN_ROOM|DONE|SKIPPED`. الحالات السبعة التي وصفتها في الوحدة ٤ تُشتق من `booking.status` + `queue_ticket.stage` معًا، بلا تكرار. |

### 1.14 `waitlist_entry` — قائمة الانتظار (جديد)
| id · clinic_id · doctor_id · patient_id · desired_from · desired_to · priority · notified_at · expires_at · status |
| --- |
| هذه هي التي تُحقّق ميزتك المميزة: «إلغاء ٦ مساءً → عرض تلقائي لمريض آخر». |

### 1.15 `prescription` (جديد، C)
| id · clinic_id · booking_id · doctor_id · issued_at · items(json) · instructions · pdf_url · status(`draft|issued|void`) |
| --- |
| **لا يُنشئ النظام أي دواء**؛ الطبيب يكتب. النظام ينسّق ويحفظ ويولّد PDF فقط. |

### 1.16 `prescription_item` (جديد، C)
| prescription_id · drug_name · dose · frequency · duration · notes |
| --- |

### 1.17 `lab_order` + 1.18 `document` (جديد، C)
| `lab_order`: order_id · booking_id · tests(json) · lab_id · status · result_document_id |
| --- |
| `document`: id · clinic_id · patient_id · kind(`lab|xray|report|consent`) · storage_key · mime · size · uploaded_by · uploaded_at · retention_until · hash |

### 1.19 `payment` + 1.20 `invoice` (جديد)
| `payment`: id · booking_id · amount · currency · method(`cash|card|wallet|online`) · status(`due|paid|refunded`) · receipt_no · recorded_by · at · gateway_ref |
| --- |
| `invoice`: id · booking_id · lines(json) · subtotal · discount · total · issued_at · pdf_url |
| **لا بوابة دفع في الموجة ٥**؛ تسجيل يدوي + إيصال. البوابة تحتاج تعاقدًا (Paymob/Fawry) وترخيصًا. |

### 1.21 `review` (جديد)
| id · booking_id · patient_id · doctor_id · ratings(6 محاور) · comment · status(`pending|published|rejected`) · reply · replied_by · at |
| --- |
| **يُقبل التقييم فقط لزيارة `COMPLETED`**، والتقييم الواحد لكل زيارة. مراجعة المحتوى قبل النشر. |

### 1.22 `audit` + `notification` (موجود جزئيًا)
| `audit` (موجود): timestamp · actor · reference · action · from_status · to_status · details → يُضاف `clinic_id`, `actor_staff_id`, `role`, `ip_hash` |
| --- |
| `notification` (جديد): id · clinic_id · booking_id · channel(`email|inapp|whatsapp`) · template · scheduled_at · sent_at · status · error |

---

## الفهارس المطلوبة (Sheets: «لوحة فهرس» أو عمود مركّب؛ SQL: فهرس حقيقي)

| الجدول | الفهرس | السبب |
| --- | --- | --- |
| booking | (clinic_id, day, doctor_id) | جدول اليوم |
| booking | (phone, day) | منع التكرار + السقف اليومي ✅ موجود منطقيًا |
| booking | (patient_id, created_at desc) | ملف المريض |
| queue_ticket | (doctor_id, stage, issued_at) | «من التالي» |
| notification | (status, scheduled_at) | المشغّل الدوري |
| audit | (clinic_id, at desc) | سجل التدقيق |

## قواعد الاحتفاظ (تُنفَّذ في الموجة ٤ مع سياسة الحذف)

| البيانات | مدة الاحتفاظ | بعدها |
| --- | --- | --- |
| طلبات لم تُؤكَّد | ١٢ شهرًا | حذف نهائي |
| حجوزات مكتملة (إداري) | ٥ سنوات | أرشفة |
| ملف طبي / وصفات | حسب ما يقرره الطبيب + مدة التقادم الطبي (تُحدَّد بمشورة قانونية) | أرشفة، لا حذف تلقائي بلا سياسة |
| سجل تدقيق | ٣ سنوات كحد أدنى | أرشفة |
| مستندات | حتى `retention_until` لكل مستند | حذف نهائي |

> **تنبيه:** أرقام الاحتفاظ أعلاه **مقترحة** لا قانونية؛ تُعتمد من مستشار قبل التنفيذ
> (`compliance-egypt.md §٥`).

## ما يجب أن يبقى كما هو

- `Requests` الحالي **لا** يُهاجَر بالقوة؛ يُضاف عمود بعمود مع قيم افتراضية، ويبقى قارئًا للقديم
  (نمط الترحيل المستخدم فعلًا في `Settings.gs` لترحيل الرمز القديم).
- لا يُكتب أي حقل طبي في `Requests` أبدًا، حتى بعد إضافة الجداول الطبية — الفصل مقصود.
