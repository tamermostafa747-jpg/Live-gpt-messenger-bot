// FAQs & offers (intent replies). Keep concise & factual.
module.exports = [
  {
    trigger: 'offer',
    keywords: ['عرض', 'عروض', 'خصم', 'باكدج', 'offer', 'اسعار'],
    examples: ['في عروض؟', 'عايزة باكدج', 'السعر كام'],
    reply: {
      title: 'عروضنا الحالية',
      description: 'اختاري الباقة المناسبة لاحتياج شعر طفلك—توفير أفضل مع نتائج واضحة.',
      highlights: [
        'شامبو + شاور جل بـ 220 بدل 270',
        'شامبو + كريم ليف إن بـ 200 بدل 250',
        'شامبو + شاور + كريم ليف إن بـ 290 بدل 380',
        'شامبو + شاور + كريم ليف إن + زيت شعر بـ 400 بدل 530'
      ],
      gallery: [
        'https://smartkidz-eg.com/smart-kidz-offers/offer%202%20shampoo-+-shower.png',
        'https://smartkidz-eg.com/smart-kidz-offers/offer%202%20shampoo-+-cream.png',
        'https://smartkidz-eg.com/smart-kidz-offers/soffer%203%20hampo-+-cream-+-shower.png',
        'https://smartkidz-eg.com/smart-kidz-offers/offer%205%20with%202%20cream.png'
      ]
    }
  },
  {
    trigger: 'info',
    keywords: ['معلومات', 'عنكم', 'براند', 'smartkidz', 'سمارت كيدز'],
    examples: ['مين سمارت كيدز', 'بتبيعوا ايه'],
    reply: {
      title: 'لمحة عن SmartKidz',
      image: 'https://smartkidz-eg.com/smart-kidz-offers/smart%20kidz%20products%20natural.png',
      description: 'منتجات طبيعية لطيفة لبشرة وشعر الأطفال، مناسبة للبشرة الحساسة من بدري وحتى سن المدرسة.',
      highlights: [
        'مكونات طبيعية مختارة بعناية',
        'نتيجة ملموسة مع الاستمرار: شعر أنعم وأقوى ولمعان صحي'
      ]
    }
  },
  {
    trigger: 'safety',
    keywords: ['آمن', 'امان', 'مرخص', 'سلامه', 'رضع', 'حديثي الولادة'],
    examples: ['هل آمن؟', 'مرخص من الصحة؟'],
    reply: {
      title: 'السلامة والترخيص',
      description: 'نلتزم بمعايير الجودة والسلامة، مع مراعاة فروة رأس وبشرة الأطفال الحساسة.',
      highlights: [
        'مرخص من وزارة الصحة وهيئة الدواء المصرية',
        'خالي من البارابين والكبريتات والسيليكون',
        'يفضل اختبار حساسية بسيط قبل الاستخدام العام'
      ]
    }
  },
  {
    trigger: 'availability',
    keywords: ['فين الاقي', 'أماكن البيع', 'صيدليات', 'الشراء', 'location'],
    examples: ['بتتباع فين؟', 'هل متوفره في الصيدليات؟'],
    reply: {
      title: 'أماكن التوفر',
      description: 'متاحة في الصيدليات ومنافذ بيع منتجات الأطفال. للطلب المباشر اكتبِ رقم الموبايل ليتواصل فريقنا.'
    }
  }
];
