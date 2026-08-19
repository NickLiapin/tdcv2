<a name="top"></a>

[English](../../data-packs/catalogue.md#top) · **Русский** · [Español](../../es/data-packs/catalogue.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/data-packs/catalogue)**

← Назад: [Установка пакетов данных](./installing-packs.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Свой пакет данных](./writing-your-own.md#top) →

---

# Каталог

Все пакеты, которые отгружаются, собранные из того же манифеста, который читает
установщик. Если языка или страны здесь нет — значит пакет не закончен: запись в
каталоге это обещание, что каждый адрес внутри разрешается.

**Сегодня 239 наборов: `common`, 86 языков и 152 стран.** Раскройте любой, чтобы увидеть,
что в нём лежит и как его поставить.

> [!NOTE]
>
> **Языковой** пакет держит то, что принадлежит языку и никакой стране — имена, цвета,
> слова, форму даты. **Страновой** держит то, что принадлежит государству — его
> идентификаторы, банки, почтовые индексы. Они складываются, и каждый блок ниже это одна
> ось: американский английский это `common` + `en` + `usa`.
>

## Common

Не привязан ни к языку, ни к стране. Нужен почти любому конфигу.

| Pack | Name | Holds |
| :--- | :--- | :--- |
| `common` | Common (locale-agnostic) | uuid, hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC, semver, and more |

Install any of them with `tdcv2 pack add <pack>`.

## Языки

Один язык, страны внутри нет.

| Pack | Name | Holds |
| :--- | :--- | :--- |
| `af` | Afrikaans | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `sq` | Albanian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ar` | Arabic | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `hy-am` | Armenian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `az` | Azerbaijani | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `eu` | Basque | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `be` | Belarusian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `bn` | Bengali | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `bs` | Bosnian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `bg` | Bulgarian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `my` | Burmese | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ca` | Catalan | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `hr` | Croatian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `cs` | Czech | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `da` | Danish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `dv` | Dhivehi | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `nl` | Dutch | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `en` | English | given names and surnames (US-frequency-weighted), gender words, country names. Shared by every English-speaking locale (USA, UK, Canada, Australia, …) |
| `et` | Estonian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `fo` | Faroese | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `fil` | Filipino | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `fi` | Finnish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `fr` | French | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `gl` | Galician | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ka` | Georgian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `de` | German | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `el` | Greek | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `gu` | Gujarati | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `he` | Hebrew | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `hi` | Hindi | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `hu` | Hungarian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `is` | Icelandic | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `id` | Indonesian | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `ga` | Irish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `it` | Italian | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `ja` | Japanese | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `jv` | Javanese | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `kn` | Kannada | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `kk` | Kazakh | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `km` | Khmer | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ko` | Korean | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `ku` | Kurdish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ky` | Kyrgyz | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `lo` | Lao | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `lv` | Latvian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `lt` | Lithuanian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `lb` | Luxembourgish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `mk` | Macedonian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ms` | Malay | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ml` | Malayalam | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `mt` | Maltese | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `mi` | Māori | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `mr` | Marathi | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `mn` | Mongolian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ne` | Nepali | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `nb` | Norwegian Bokmål | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `nn` | Norwegian Nynorsk | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `fa` | Persian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `pl` | Polish | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `pt` | Portuguese | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `pa-in` | Punjabi | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ro` | Romanian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ru` | Russian | given names, gendered surnames and patronymics, gender words, months and weekdays, colors, country names. Shared by every Russian-speaking locale |
| `gd` | Scottish Gaelic | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `sr` | Serbian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `zh-cn` | Simplified Chinese | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `si` | Sinhala | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `sk` | Slovak | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `sl` | Slovenian | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `es` | Spanish | given names and the paternal+maternal surname pair, address wording, company legal forms, commerce and everyday vocabulary. Shared by every Spanish-speaking locale (Mexico, Argentina, Spain, Colombia, …) |
| `sw` | Swahili | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `sv` | Swedish | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `tg` | Tajik | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ta` | Tamil | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `te` | Telugu | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `th` | Thai | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `bo` | Tibetan | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `tr` | Turkish | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `tk` | Turkmen | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `uk` | Ukrainian | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `ur` | Urdu | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `ug-cn` | Uyghur | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `uz-latn` | Uzbek (Latin) | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `vi` | Vietnamese | address, airline, animal, book, clothing, color, commerce, company, date, education, event, finance, … |
| `cy` | Welsh | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |
| `yo` | Yoruba | DATE_LOCALE, address, airline, animal, book, clothing, color, commerce, company, date, education, event, … |

Install any of them with `tdcv2 pack add <pack>`.

## Страны

Одна страна, языка внутри нет.

| Pack | Name | Holds |
| :--- | :--- | :--- |
| `albania` | Albania | docs, education, finance, geo, government, holiday, phone, sport, tax, telecom, vehicle |
| `algeria` | Algeria | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `angola` | Angola | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `argentina` | Argentina | CUIT and CUIL, the CBU with both of its check digits, the 23 provinces and CABA with ISO codes, the CPA postal format whose leading letter is the province, cities, banks with their BCRA codes, universities, Primera División clubs, holidays and the Mercosur plate |
| `armenia` | Armenia | docs, education, finance, geo, government, holiday, language, phone, phoneLandline, product, sport, tax, telecom, vehicle |
| `australia` | Australia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `austria` | Austria | education, finance, geo, holiday, phone, sport, tax, vehicle |
| `azerbaijan` | Azerbaijan | docs, education, finance, geo, government, holiday, phone, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `bahrain` | Bahrain | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `bangladesh` | Bangladesh | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `belarus` | Belarus | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `belgium` | Belgium | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `benin` | Benin | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `bhutan` | Bhutan | docs, education, finance, geo, government, holiday, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, phoneNational, society, sport, tax, telecom, vehicle |
| `bolivia` | Bolivia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `bosnia_and_herzegovina` | Bosnia And Herzegovina | docs, education, finance, geo, government, holiday, language, phone, phoneLandline, sport, tax, vehicle |
| `brazil` | Brazil | docs, education, finance, geo, holiday, phone, phoneAreaCode, sport, tax, vehicle |
| `bulgaria` | Bulgaria | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `burkina_faso` | Burkina Faso | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `cambodia` | Cambodia | docs, education, finance, geo, government, holiday, legal, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, phoneMobilePrefixWithLength, sport, tax, vehicle |
| `cameroon` | Cameroon | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `canada` | Canada | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `cape_verde` | Cape Verde | docs, education, finance, geo, holiday, phone, sport |
| `chad` | Chad | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `chile` | Chile | RUT and RUN with the módulo-11 check character including K, the 16 regions with their roman, ISO and CUT codes, 345 comunas with their Correos de Chile codes, cities, banks with CMF codes, universities, Primera División clubs, holidays and the post-2007 plate alphabet |
| `china` | China | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `colombia` | Colombia | NIT with its mod-11 check digit, cédulas, the 32 departments and Bogotá with DANE and ISO codes, municipalities, postal codes drawn from the real department blocks, banks with their Banco de la República codes, universities, Categoría Primera A clubs, the holidays and which of them the Ley Emiliani moves to Monday, and the plate formats |
| `comoros` | Comoros | education, finance, geo, holiday, phone |
| `congo` | Congo | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `costa_rica` | Costa Rica | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `croatia` | Croatia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `cuba` | Cuba | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `cyprus` | Cyprus | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `czechia` | Czechia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `denmark` | Denmark | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `djibouti` | Djibouti | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `dominican_republic` | Dominican Republic | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `dr_congo` | Dr Congo | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `east_timor` | East Timor | docs, education, finance, geo, holiday, phone, sport |
| `ecuador` | Ecuador | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `egypt` | Egypt | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `el_salvador` | El Salvador | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `equatorial_guinea` | Equatorial Guinea | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `estonia` | Estonia | docs, education, finance, geo, government, holiday, phone, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `finland` | Finland | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `france` | France | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `gabon` | Gabon | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `georgia` | Georgia | docs, education, finance, geo, government, holiday, legal, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, sport, tax, vehicle |
| `germany` | Germany | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `ghana` | Ghana | docs, education, finance, geo, holiday, language, phone, phoneNational, phonePrefix, sport, tax, vehicle |
| `greece` | Greece | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `guatemala` | Guatemala | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `guinea` | Guinea | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `guinea_bissau` | Guinea Bissau | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `haiti` | Haiti | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `honduras` | Honduras | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `hungary` | Hungary | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `iceland` | Iceland | docs, education, finance, geo, government, holiday, phone, phoneLandline, sport, tax, telecom, vehicle |
| `india` | India | docs, education, finance, geo, holiday, language, phone, sport, tax, vehicle |
| `indonesia` | Indonesia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `iran` | Iran | docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `iraq` | Iraq | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `ireland` | Ireland | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `israel` | Israel | docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `italy` | Italy | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `ivory_coast` | Ivory Coast | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `japan` | Japan | docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `jordan` | Jordan | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `kazakhstan` | Kazakhstan | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `kenya` | Kenya | docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `kuwait` | Kuwait | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `kyrgyzstan` | Kyrgyzstan | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `laos` | Laos | docs, education, finance, geo, government, holiday, legal, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, sport, tax, vehicle |
| `latvia` | Latvia | docs, education, finance, geo, government, holiday, phone, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `lebanon` | Lebanon | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `libya` | Libya | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `liechtenstein` | Liechtenstein | education, finance, geo, holiday, phone, sport, vehicle |
| `lithuania` | Lithuania | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `luxembourg` | Luxembourg | docs, education, finance, geo, government, holiday, phone, phoneLandline, phoneLandlinePrefix, phoneMobilePrefix, phoneNational, sport, … |
| `macau` | Macau | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `madagascar` | Madagascar | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `malaysia` | Malaysia | docs, education, finance, geo, government, holiday, phone, sport, tax, vehicle |
| `maldives` | Maldives | calendar, docs, education, finance, geo, government, holiday, holidayDate, holidayEnglish, phone, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `mali` | Mali | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `malta` | Malta | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `mauritania` | Mauritania | docs, education, finance, geo, holiday, phone, sport |
| `mexico` | Mexico | CURP, RFC, NSS and clave de elector with real check digits, CLABE with its Banxico bank codes, states and their INEGI/ISO/RENAPO codes, municipalities, cities, postal codes, universities, holidays, sports teams, plates and the SAT tax regimes |
| `moldova` | Moldova | docs, education, finance, food, geo, holiday, language, phone, sport, tax, vehicle |
| `monaco` | Monaco | education, finance, geo, holiday, phone, sport, vehicle |
| `mongolia` | Mongolia | docs, education, finance, geo, government, holiday, legal, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, sport, tax, telecom, vehicle |
| `morocco` | Morocco | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `mozambique` | Mozambique | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `myanmar` | Myanmar | docs, education, finance, geo, government, holiday, legal, phone, phoneLandline, phoneMobilePrefix, sport, tax, vehicle |
| `nepal` | Nepal | calendar, docs, education, finance, geo, holiday, phone, phoneAreaCode, phoneLandline, sport, symbol, symbolEnglish, tax, vehicle |
| `netherlands` | Netherlands | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `new_zealand` | New Zealand | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `nicaragua` | Nicaragua | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `niger` | Niger | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `nigeria` | Nigeria | docs, education, finance, geo, holiday, language, phone, phoneNational, phonePrefix, sport, tax, vehicle |
| `north_macedonia` | North Macedonia | docs, education, finance, geo, government, holiday, language, phone, phoneAreaCode, sport, tax, vehicle |
| `norway` | Norway | docs, education, finance, geo, government, holiday, phone, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `oman` | Oman | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `pakistan` | Pakistan | docs, education, finance, geo, holiday, language, phone, sport, tax, vehicle |
| `palestine` | Palestine | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `panama` | Panama | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `paraguay` | Paraguay | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `peru` | Peru | RUC with its weighted mod-11 check digit, DNI, the 25 first-level units with INEI ubigeo and ISO codes, all 196 provinces, cities, banks with BCRP codes, the CCI account shape, universities, Liga 1 clubs, holidays and the MTC plate layouts |
| `philippines` | Philippines | docs, education, finance, geo, holiday, person, phone, sport, tax, vehicle |
| `poland` | Poland | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `portugal` | Portugal | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `puerto_rico` | Puerto Rico | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `qatar` | Qatar | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `romania` | Romania | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `russia` | Russia | cities and federal subjects, street names, universities, holidays, sports clubs. INN/SNILS/OGRN/KPP, bank BIK/account, license plate and phone are built-in checksum generators (russia.*) |
| `rwanda` | Rwanda | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `san_marino` | San Marino | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `sao_tome_and_principe` | Sao Tome And Principe | docs, education, finance, geo, holiday, phone, sport |
| `saudi_arabia` | Saudi Arabia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `senegal` | Senegal | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `serbia` | Serbia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `singapore` | Singapore | docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `slovakia` | Slovakia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `slovenia` | Slovenia | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `somalia` | Somalia | education, finance, geo, holiday, phone, sport |
| `south_africa` | South Africa | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `south_korea` | South Korea | docs, education, finance, geo, holiday, phone, phoneAreaCode, phoneLandline, sport, tax, vehicle |
| `spain` | Spain | DNI, NIE, CIF and NIF, the CCC and its ES IBAN, the social-security NUSS, the 17 autonomous communities and 50 provinces with their INE and ISO codes, municipalities, postal codes that encode the province, universities, LaLiga and Segunda clubs, holidays and the current plate format |
| `sri_lanka` | Sri Lanka | docs, education, finance, geo, holiday, language, phone, phoneLandline, sport, tax, vehicle |
| `sudan` | Sudan | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `sweden` | Sweden | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `switzerland` | Switzerland | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `syria` | Syria | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `taiwan` | Taiwan | calendar, docs, education, finance, geo, government, holiday, legal, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, sport, tax, telecom, vehicle |
| `tajikistan` | Tajikistan | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `tanzania` | Tanzania | docs, education, finance, geo, holiday, holidayEnglish, phone, phoneLandline, sport, tax, vehicle |
| `thailand` | Thailand | calendar, docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `togo` | Togo | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `tunisia` | Tunisia | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `turkey` | Turkey | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `turkmenistan` | Turkmenistan | docs, education, finance, geo, government, holiday, phone, phoneAreaCode, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, vehicle |
| `uae` | Uae | docs, education, finance, geo, holiday, phone, sport, vehicle |
| `uganda` | Uganda | culture, docs, education, finance, geo, holiday, phone, phoneLandline, sport, tax, vehicle |
| `ukraine` | Ukraine | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `united_kingdom` | United Kingdom | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `uruguay` | Uruguay | the cédula de identidad and RUT with their check digits, the 19 departments with ISO codes, cities, the whole banking sector with BCU numbers, universities, Primera División clubs, holidays and the Mercosur plate whose first letter is the registering department |
| `usa` | Usa | SSN/ITIN/EIN, ZIP codes, states, street names, ABA routing numbers, phone format, license plates |
| `uzbekistan` | Uzbekistan | docs, education, finance, geo, government, holiday, phone, phoneAreaCode, phoneAreaCodeWithRegion, phoneLandline, phoneMobilePrefix, phoneNational, sport, tax, telecom, vehicle |
| `vatican_city` | Vatican City | education, finance, geo, holiday, phone, sport, vehicle |
| `venezuela` | Venezuela | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `vietnam` | Vietnam | docs, education, finance, geo, holiday, phone, sport, tax, vehicle |
| `yemen` | Yemen | docs, education, finance, geo, holiday, phone, sport |
| `zimbabwe` | Zimbabwe | docs, education, finance, geo, holiday, language, phone, sport, tax, vehicle |

Install any of them with `tdcv2 pack add <pack>`.

---

← Назад: [Установка пакетов данных](./installing-packs.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Свой пакет данных](./writing-your-own.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/data-packs/catalogue)**
