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
const showPath = (path) => path || '/';

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

// Обхід усього дерева вглиб; для кожного елемента віддає назву, шлях і сам елемент.
function* walk(folder, folderPath = '') {
  for (const [name, node] of childrenOf(folder, folderPath)) {
    const path = joinPath(folderPath, name);
    yield { name, path, node };
    if (isFolder(node)) yield* walk(node, path);
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

// ---------- Перевірка значень опцій ----------

function parsePositiveInt(value) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new CliError(`Опція --limit очікує додатне ціле число, а отримано "${value}".`, EXIT_USAGE);
  }
  return number;
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
  .option('-f, --file <path>', 'шлях до JSON-файлу з каталогом', DEFAULT_FILE);

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
    if (err.code === 'commander.help') return EXIT_USAGE; // команду не вказано, довідку вже виведено
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
