import type { Client, Deal, Task, User, Stage } from "../domain.js";
export const users: User[] = [
  { id: "u-admin", name: "Александр Ким", role: "admin" },
  { id: "u-rop", name: "Алия Садыкова", role: "rop" },
  { id: "u-manager", name: "Данияр Омаров", role: "manager" },
];
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString();
};
const people = [
  [
    "Айгерим Нурланова",
    "ТОО «Аспан Групп»",
    "Алматы",
    "a.nurlanova@aspan.example",
  ],
  ["Тимур Сулейменов", "Nomad Logistics", "Астана", "timur@nomad.example"],
  [
    "Мария Иванова",
    "Кофейни «Тёплый день»",
    "Алматы",
    "maria@teplyden.example",
  ],
  ["Ерлан Бекетов", "ТОО «КазСтрой»", "Шымкент", "erlan@kazstroy.example"],
  ["Анастасия Волкова", "Studio Forma", "Алматы", "anna@forma.example"],
  ["Руслан Абдрахманов", "Qazaq Digital", "Астана", "ruslan@qazaq.example"],
  [
    "Динара Оспанова",
    "Сеть клиник «Сенім»",
    "Караганда",
    "dinara@senim.example",
  ],
  ["Сергей Петров", "ТОО «ТехноПром»", "Павлодар", "sergey@technoprom.example"],
  ["Мадина Ахметова", "Bloom Market", "Алматы", "madina@bloom.example"],
  ["Арман Тлеубердин", "Steppe Travel", "Астана", "arman@steppe.example"],
  [
    "Елена Смирнова",
    "Образовательный центр «Рост»",
    "Алматы",
    "elena@rost.example",
  ],
  [
    "Бауыржан Касымов",
    "ТОО «Алтын Агро»",
    "Костанай",
    "bauyrzhan@agro.example",
  ],
  ["Сауле Жумабаева", "Orda Furniture", "Астана", "saule@orda.example"],
  ["Илья Ковалёв", "Rocket Delivery", "Алматы", "ilya@rocket.example"],
  ["Асель Муратова", "Alem Education", "Шымкент", "asel@alem.example"],
];
const distribution: Stage[] = [
  "negotiation",
  "qualified",
  "new",
  "payment",
  "won",
  "negotiation",
  "new",
  "qualified",
  "payment",
  "won",
  "new",
  "lost",
  "new",
  "qualified",
  "new",
];
export const clients: Client[] = people.map(
  ([name, company, city, email], i) => ({
    id: `c-${i + 1}`,
    name: name!,
    company: company!,
    city: city!,
    email: email!,
    phone: `+7 701 ${String(210 + i)} ${String(10 + i)} ${String(30 + i)}`,
    stage: distribution[i]!,
    ownerId: users[i % 3]!.id,
    source: ["Рекомендация", "Сайт", "Входящий звонок"][i % 3]!,
    notes:
      "Обсуждаем автоматизацию отдела продаж. Предпочитает общение в первой половине дня.",
    createdAt: day(-i * 2),
  }),
);
const titles = [
  "CRM для отдела продаж",
  "Автоматизация логистики",
  "Запуск программы лояльности",
  "Корпоративная лицензия",
  "Внедрение аналитики",
  "Интеграция с телефонией",
  "CRM для сети клиник",
  "Автоматизация заявок",
  "Лицензия на 20 сотрудников",
  "Поддержка на год",
  "Обучение команды",
  "Комплексное внедрение",
];
const amounts = [
  2400000, 1850000, 680000, 5200000, 1250000, 960000, 3100000, 1750000, 2200000,
  840000, 450000, 3800000,
];
export const deals: Deal[] = titles.map((title, i) => ({
  id: `d-${i + 1}`,
  title,
  clientId: clients[i]!.id,
  ownerId: clients[i]!.ownerId,
  stage: distribution[i]!,
  amount: amounts[i]!,
  createdAt: day(-i * 2),
}));
const taskTitles = [
  "Отправить коммерческое предложение",
  "Обсудить интеграцию с 1С",
  "Провести демо для команды",
  "Согласовать условия договора",
  "Запросить обратную связь",
  "Подготовить план внедрения",
  "Уточнить количество лицензий",
  "Связаться после презентации",
  "Выставить счёт на оплату",
  "Подвести итоги запуска",
];
export const tasks: Task[] = taskTitles.map((title, i) => ({
  id: `t-${i + 1}`,
  title,
  clientId: clients[i]!.id,
  ownerId: clients[i]!.ownerId,
  dueDate: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(day(i - 3))),
  completed: i === 4 || i === 9,
  createdAt: day(-i - 1),
}));
