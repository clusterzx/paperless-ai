{
  description = "Paperless-AI - AI-powered extension for Paperless-ngx with automatic document classification, smart tagging, and semantic search";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    ...
  }:
    {
      nixosModules.default = import ./module.nix;
      nixosModule = self.nixosModules.default;
    }
    // flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      # Python environment with all required packages for RAG service
      pythonEnv = pkgs.python313.withPackages (ps:
        with ps; [
          fastapi # Web framework for RAG API
          uvicorn # ASGI server
          python-dotenv # Environment file loading
          requests # HTTP client
          numpy # Numerical computing
          pytorch # Machine learning framework
          sentence-transformers # Text embeddings
          chromadb # Vector database
          rank-bm25 # BM25 ranking algorithm
          nltk # Natural language processing
          tqdm # Progress bars
          pydantic # Data validation
        ]);

      # Node.js runtime (dependencies managed via npm)
      nodejs = pkgs.nodejs;

      # Main Paperless-AI package built with buildNpmPackage for proper npm dependency management
      paperless-ai = pkgs.buildNpmPackage {
        pname = "paperless-ai";
        version = "1.0.0";

        src = ./.;

        npmDepsHash = "sha256-nAcI3L0fvVI/CdUxWYg8ZiPRDjF7dW+dcIKC3KlHjNQ=";

        nativeBuildInputs = with pkgs; [
          sqlite
        ];

        buildInputs = with pkgs; [
          sqlite
        ];

        # Don't run the default npm build script
        dontNpmBuild = true;

        meta = with pkgs.lib; {
          description = "AI-powered extension for Paperless-ngx that brings automatic document classification, smart tagging, and semantic search";
          homepage = "https://github.com/clusterzx/paperless-ai";
          license = licenses.mit;
          maintainers = [];
          platforms = platforms.linux ++ platforms.darwin;
        };
      };

      paperless-ai-rag = pkgs.writeShellApplication {
        name = "paperless-ai-rag";
        runtimeInputs = [pythonEnv];
        text = ''
          WORK_DIR="$HOME/.local/share/paperless-ai-rag"
          mkdir -p "$WORK_DIR/data"

          if [ ! -f "$WORK_DIR/main.py" ]; then
            echo "Setting up Paperless-AI RAG service in $WORK_DIR..."
            cp ${./main.py} "$WORK_DIR/main.py"
            chmod u+w "$WORK_DIR/main.py"
          fi

          cd "$WORK_DIR"
          exec python main.py "$@"
        '';
        meta = with pkgs.lib; {
          description = "RAG service for Paperless-AI - semantic search and document Q&A";
          license = licenses.mit;
          platforms = platforms.linux ++ platforms.darwin;
        };
      };
    in {
      # Package outputs
      packages = {
        default = paperless-ai;
        paperless-ai = paperless-ai;
        paperless-ai-rag = paperless-ai-rag;
      };

      # Development environments
      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          nodejs
          nodePackages.npm
          pythonEnv
        ];
      };

      apps = {
        paperless-ai = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai";
          meta = {
            description = "AI-powered extension for Paperless-ngx with automatic document classification, smart tagging, and semantic search";
          };
        };
        paperless-ai-rag = {
          type = "app";
          program = "${paperless-ai-rag}/bin/paperless-ai-rag";
          meta = {
            description = "RAG (Retrieval-Augmented Generation) service for Paperless-AI - semantic search and document Q&A";
          };
        };
      };
    });
}
