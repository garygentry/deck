import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Icon,
  Input,
  Kbd,
  KbdGroup,
  Label,
  RadioGroup,
  RadioGroupItem,
  Separator,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/ui";
import { Specimen, type WorkbenchSectionDef } from "../kit.js";

const BUTTON_VARIANTS = ["default", "secondary", "outline", "ghost", "link", "destructive"] as const;
const BADGE_VARIANTS = ["default", "secondary", "outline", "destructive"] as const;

function Primitives() {
  return (
    <>
      <Specimen label="Button variants">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </Specimen>
      <Specimen label="Button sizes and states">
        <Button size="xs">xs</Button>
        <Button size="sm">sm</Button>
        <Button>default</Button>
        <Button size="lg">lg</Button>
        <Button size="icon" aria-label="Copy link">
          <Icon name="link" />
        </Button>
        <Button>
          <Icon name="play" />
          With icon
        </Button>
        <Button disabled>disabled</Button>
        <Button loading>Saving</Button>
      </Specimen>
      <Specimen label="Badge variants">
        {BADGE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </Specimen>
      <Specimen label="Form controls">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-input">Host name</Label>
          <Input id="wb-input" placeholder="nas-01" className="w-48" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-invalid">Invalid</Label>
          <Input id="wb-invalid" defaultValue="bad value" aria-invalid="true" className="w-48" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-disabled">Disabled</Label>
          <Input id="wb-disabled" defaultValue="read only" disabled className="w-48" />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="wb-check" defaultChecked />
          <Label htmlFor="wb-check">Include waived</Label>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wb-notes">Notes</Label>
          <Textarea id="wb-notes" placeholder="Why this waiver exists" className="w-64" />
        </div>
        <RadioGroup aria-label="Density" defaultValue="comfortable" className="gap-2">
          {["compact", "comfortable"].map((value) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`wb-density-${value}`} value={value} />
              <Label htmlFor={`wb-density-${value}`}>{value}</Label>
            </div>
          ))}
        </RadioGroup>
      </Specimen>
      <Specimen label="Kbd">
        <p className="text-sm text-muted-foreground">
          Search with <Kbd>/</Kbd>, open the palette with{" "}
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </p>
      </Specimen>
      <Specimen label="Alert">
        <Alert className="max-w-md">
          <Icon name="info" />
          <AlertTitle>Snapshot is 2 hours old</AlertTitle>
          <AlertDescription>Run the collector to refresh inventory.</AlertDescription>
        </Alert>
        <Alert variant="destructive" className="max-w-md">
          <Icon name="circle-x" />
          <AlertTitle>Config failed to load</AlertTitle>
          <AlertDescription>deck.config.json is not valid JSON.</AlertDescription>
        </Alert>
      </Specimen>
      <Specimen label="Card, tabs, separator">
        <Card className="w-72">
          <CardHeader>
            <CardTitle>nas-01</CardTitle>
            <CardDescription>Storage · 12 services</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="drift">Drift</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="text-sm">
                Declared and observed agree.
              </TabsContent>
              <TabsContent value="drift" className="text-sm">
                No findings.
              </TabsContent>
            </Tabs>
            <Separator className="my-3" />
            <p className="text-sm text-muted-foreground">Last seen 6m ago</p>
          </CardContent>
        </Card>
      </Specimen>
      <Specimen label="Skeleton">
        <div className="flex w-72 flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      </Specimen>
      <Specimen label="Table">
        <Table>
          <TableCaption>Hosts in the estate</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Services</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>nas-01</TableCell>
              <TableCell>storage</TableCell>
              <TableCell className="text-right tabular-nums">12</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>edge-01</TableCell>
              <TableCell>router</TableCell>
              <TableCell className="text-right tabular-nums">3</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Specimen>
    </>
  );
}

export const primitives: WorkbenchSectionDef = {
  id: "primitives",
  title: "Primitives",
  Demo: Primitives,
};
