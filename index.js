import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';

const DEFAULT_FILE = 'data.json';
const ROOT_KEY = 'root_folder_metadata';
const EXIT_FAIL = 1; // помилка виконання: файл, JSON, елемент чи поле не знайдено
const EXIT_USAGE = 2; // неправильний виклик: аргумент, опція, команда

// Очікувана помилка: повідомлення вже написане для користувача, стек не потрібен.
class CliError extends Error {
  constructor(message, exitCode = EXIT_FAIL) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------- Допоміжні функції для роботи з даними ----------

const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFolder = (node) => 'Object' in node; // у папки є ключ Object (може бути null)
const joinPath = (parent, name) => (parent ? `${parent}/${name}` : name);
const kindOf = (node) => (isFolder(node) ? 'папка' : 'файл');
const isHidden = (node) => node.hidden === true;
const showPath = (path) => path || '/';

// Розмір у зручному вигляді: 2457600 -> "2.34 МіБ".
function formatSize(bytes) {
  const units = ['Б', 'КіБ', 'МіБ', 'ГіБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}

function loadCatalog(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new CliError(`Файл "${filePath}" не знайдено.`);
    if (err.code === 'EISDIR') throw new CliError(`"${filePath}" — це папка, а не JSON-файл.`);
    if (err.code === 'EACCES') throw new CliError(`Немає доступу до файлу "${filePath}".`);
    throw new CliError(`Не вдалося прочитати файл "${filePath}": ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, '')); // прибираємо BOM, якщо він є
  } catch (err) {
    throw new CliError(`Файл "${filePath}" містить некоректний JSON (${err.message}).`);
  }

  const root = data?.[ROOT_KEY];
  if (!isObject(root) || !isFolder(root)) {
    throw new CliError(`У файлі "${filePath}" немає кореневої папки "${ROOT_KEY}".`);
  }
  return root;
}

// Дочірні елементи папки як масив пар [назва, елемент]. Object: null — порожня папка.
function childrenOf(folder, folderPath) {
  const content = folder.Object;
  if (content !== null && !isObject(content)) {
    throw new CliError(`Поле Object папки "${showPath(folderPath)}" має бути об'єктом або null.`);
  }
  const entries = Object.entries(content ?? {});
  for (const [name, node] of entries) {
    if (!isObject(node)) {
      throw new CliError(`Елемент "${joinPath(folderPath, name)}" має бути об'єктом.`);
    }
  }
  return entries;
}

// Обхід усього дерева вглиб; для кожного елемента віддає назву, шлях, сам елемент
// і ознаку "прихований" (власну або успадковану від прихованої папки).
function* walk(folder, folderPath = '', parentHidden = false) {
  for (const [name, node] of childrenOf(folder, folderPath)) {
    const path = joinPath(folderPath, name);
    const hidden = parentHidden || isHidden(node);
    yield { name, path, node, hidden };
    if (isFolder(node)) yield* walk(node, path, hidden);
  }
}

// Знаходить елемент за шляхом виду "summer_2007/picture1.jpg"; порожній шлях — корінь.
function findNode(root, pathText) {
  let node = root;
  let path = '';
  for (const part of pathText.split('/').filter(Boolean)) {
    if (!isFolder(node)) {
      throw new CliError(`"${showPath(path)}" — це файл, у ньому немає елемента "${part}".`);
    }
    const found = childrenOf(node, path).find(([name]) => name === part);
    if (!found) {
      const where = path ? `у папці "${path}"` : 'у кореневій папці';
      throw new CliError(`Елемент "${joinPath(path, part)}" не знайдено: ${where} немає "${part}".`);
    }
    node = found[1];
    path = joinPath(path, part);
  }
  return { node, path };
}

// Значення поля за шляхом виду "Object/best/object_count"; індекси масивів — числами.
function getField(element, elementPath, fieldText) {
  const keys = fieldText.split('/').filter(Boolean);
  if (keys.length === 0) throw new CliError('Не вказано ім\'я поля.', EXIT_USAGE);

  let value = element;
  let walked = '';
  for (const key of keys) {
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(key) || Number(key) >= value.length) {
        throw new CliError(`У масиві "${walked}" немає елемента з індексом "${key}".`);
      }
      value = value[Number(key)];
    } else if (isObject(value)) {
      if (!Object.hasOwn(value, key)) {
        throw new CliError(`Поле "${joinPath(walked, key)}" відсутнє в елементі "${showPath(elementPath)}".`);
      }
      value = value[key];
    } else {
      throw new CliError(
        `Поле "${walked}" має значення ${JSON.stringify(value)}, тож у ньому немає "${key}".`,
      );
    }
    walked = joinPath(walked, key);
  }
  return value;
}

// Сума розмірів усіх файлів папки разом із вкладеними; для файлу — його розмір.
function totalSize(node, path, skipHidden) {
  if (!isFolder(node)) {
    if (!Number.isFinite(node.size) || node.size < 0) {
      throw new CliError(`У файлі "${path}" немає коректного числового поля size.`);
    }
    return node.size;
  }
  let sum = 0;
  for (const [name, child] of childrenOf(node, path)) {
    if (skipHidden && isHidden(child)) continue; // прихована папка пропускається разом із вмістом
    sum += totalSize(child, joinPath(path, name), skipHidden);
  }
  return sum;
}

// ---------- Перевірка значень опцій ----------

function parsePositiveInt(value) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new CliError(`Опція --limit очікує додатне ціле число, а отримано "${value}".`, EXIT_USAGE);
  }
  return number;
}

function parseKind(value) {
  if (value !== 'file' && value !== 'folder') {
    throw new CliError(`Опція --type приймає "file" або "folder", а отримано "${value}".`, EXIT_USAGE);
  }
  return value;
}

// ---------- Опис програми та глобальна опція ----------

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const HELP_TITLES = {
  'Usage:': 'Використання:',
  'Arguments:': 'Аргументи:',
  'Options:': 'Опції:',
  'Global Options:': 'Глобальні опції:',
  'Commands:': 'Команди:',
};

const program = new Command();
program
  .name('node index.js')
  .description('Перегляд каталогу на диску, описаного у JSON-файлі.')
  .version(pkg.version, '-V, --version', 'показати версію програми')
  .helpOption('-h, --help', 'показати довідку')
  .helpCommand('help [command]', 'показати довідку про команду')
  .configureHelp({
    showGlobalOptions: true,
    styleTitle: (title) => HELP_TITLES[title] ?? title,
    optionDescription: (option) =>
      option.defaultValue === undefined
        ? option.description
        : `${option.description} (за замовчуванням: ${option.defaultValue})`,
  })
  .configureOutput({ outputError: () => {} }) // англійські повідомлення commander не показуємо
  .exitOverride() // замість process.exit commander кидає виняток, який ми обробимо самі
  .requiredOption('-f, --file <path>', 'шлях до JSON-файлу з каталогом', DEFAULT_FILE);

const loadRoot = () => loadCatalog(program.opts().file);

// ---------- Загальні можливості ----------

program
  .command('list')
  .description('стислий перелік усіх елементів каталогу (тип і шлях)')
  .option('-l, --limit <n>', 'показати не більше n елементів', parsePositiveInt)
  .action((options) => {
    const items = [...walk(loadRoot())];
    const shown = options.limit ? items.slice(0, options.limit) : items;
    for (const { path, node } of shown) {
      console.log(`${kindOf(node).padEnd(5)}  ${path}`);
    }
    console.log(`Показано ${shown.length} з ${items.length}.`);
  });

program
  .command('show')
  .description('показати один елемент каталогу цілком (у форматі JSON)')
  .argument('<path>', 'шлях до елемента, напр. summer_2007/picture1.jpg')
  .action((pathText) => {
    const { node } = findNode(loadRoot(), pathText);
    console.log(JSON.stringify(node, null, 2));
  });

program
  .command('field')
  .description('показати значення окремого поля елемента (зокрема вкладеного)')
  .argument('<path>', 'шлях до елемента, напр. Azov_2011')
  .argument('<field>', 'поле; вкладені поля через "/", напр. Object/best/object_count')
  .action((pathText, fieldText) => {
    const { node, path } = findNode(loadRoot(), pathText);
    console.log(JSON.stringify(getField(node, path, fieldText), null, 2));
  });

// ---------- Можливості варіанта 3: каталог на диску ----------

program
  .command('ls')
  .description('вміст папки (один рівень); приховані елементи — за опцією -a')
  .argument('[folder]', 'шлях до папки; без аргументу — коренева папка')
  .option('-a, --all', 'показувати також приховані елементи')
  .action((folderText = '', options) => {
    const { node, path } = findNode(loadRoot(), folderText);
    if (!isFolder(node)) throw new CliError(`"${path}" — це файл, а не папка.`);

    const entries = childrenOf(node, path);
    const visible = options.all ? entries : entries.filter(([, child]) => !isHidden(child));
    const width = Math.max(0, ...visible.map(([name]) => name.length));

    console.log(`Вміст ${path ? `папки "${path}"` : 'кореневої папки'}:`);
    for (const [name, child] of visible) {
      const info = isFolder(child)
        ? `елементів: ${childrenOf(child, joinPath(path, name)).length}`
        : Number.isFinite(child.size) ? formatSize(child.size) : 'розмір невідомий';
      const mark = isHidden(child) ? '  [прихований]' : '';
      console.log(`  ${kindOf(child).padEnd(5)}  ${name.padEnd(width)}  ${info}${mark}`);
    }
    if (visible.length === 0) console.log('  (порожньо)');

    const hiddenCount = entries.length - visible.length;
    if (hiddenCount > 0) console.log(`Приховано елементів: ${hiddenCount} (опція -a покаже їх).`);
  });

program
  .command('size')
  .description('сумарний розмір папки з урахуванням вкладених елементів')
  .argument('[path]', 'шлях до папки; без аргументу — коренева папка')
  .option('--exclude-hidden', 'не враховувати приховані елементи')
  .action((pathText = '', options) => {
    const { node, path } = findNode(loadRoot(), pathText);
    const bytes = totalSize(node, path, options.excludeHidden === true);
    const label = !isFolder(node) ? `файлу "${path}"` : path ? `папки "${path}"` : 'кореневої папки';
    const note = options.excludeHidden ? ', без прихованих' : '';
    console.log(`Розмір ${label}: ${bytes} байт (${formatSize(bytes)})${note}`);
  });

program
  .command('find')
  .description('пошук файлів і папок за назвою в усьому дереві')
  .argument('<name>', 'частина назви (регістр не враховується)')
  .option('-e, --exact', 'шукати лише повний збіг назви')
  .option('-t, --type <kind>', 'шукати лише "file" або "folder"', parseKind)
  .action((query, options) => {
    const needle = query.trim().toLowerCase();
    if (needle === '') throw new CliError('Назва для пошуку порожня.', EXIT_USAGE);

    const matches = [...walk(loadRoot())].filter(({ name, node }) => {
      const lower = name.toLowerCase();
      const nameMatches = options.exact ? lower === needle : lower.includes(needle);
      const typeMatches = !options.type || options.type === (isFolder(node) ? 'folder' : 'file');
      return nameMatches && typeMatches;
    });

    if (matches.length === 0) {
      console.log(`Нічого не знайдено за запитом "${query}".`);
      return;
    }
    for (const { path, node, hidden } of matches) {
      console.log(`${kindOf(node).padEnd(5)}  ${path}${hidden ? '  [прихований]' : ''}`);
    }
    console.log(`Знайдено: ${matches.length}.`);
  });

// ---------- Обробка помилок і запуск ----------

function translateCommanderError(err) {
  const quoted = err.message.match(/'([^']*)'/)?.[1] ?? '';
  switch (err.code) {
    case 'commander.missingArgument':
      return `Не вказано обов'язковий аргумент "${quoted}".`;
    case 'commander.optionMissingArgument':
      return `Опція "${quoted}" потребує значення.`;
    case 'commander.unknownOption':
      return `Невідома опція "${quoted}".`;
    case 'commander.unknownCommand':
      return `Невідома команда "${quoted}".`;
    case 'commander.excessArguments':
      return `Забагато аргументів${quoted ? ` для команди "${quoted}"` : ''}.`;
    default:
      return 'Некоректний виклик програми.';
  }
}

// Повертає код завершення; повідомлення виводить у stderr.
function handleError(err) {
  if (err instanceof CliError) {
    console.error(`Помилка: ${err.message}`);
    return err.exitCode;
  }
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return 0;
    // "help <команда>" завершується кодом 0, а запуск без команди — помилкою виклику
    if (err.code === 'commander.help') return err.exitCode === 0 ? 0 : EXIT_USAGE;
    console.error(`Помилка: ${translateCommanderError(err)}`);
    console.error('Подивитися довідку: node index.js --help');
    return EXIT_USAGE;
  }
  console.error(`Внутрішня помилка програми: ${err.message}`);
  return EXIT_FAIL;
}

try {
  program.parse();
} catch (err) {
  process.exitCode = handleError(err);
}
