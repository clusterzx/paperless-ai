{
  description = "Paperless-AI - AI-powered extension for Paperless-ngx";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      # Python dependencies
      pythonEnv = pkgs.python313.withPackages (ps:
        with ps; [
          fastapi
          uvicorn
          python-dotenv
          requests
          numpy
          pytorch
          sentence-transformers
          chromadb
          rank-bm25
          nltk
          tqdm
          pydantic
        ]);

      # Node.js dependencies are handled by npm/package.json
      nodejs = pkgs.nodejs;

      # Build the package
      paperless-ai = pkgs.buildNpmPackage {
        pname = "paperless-ai";
        version = "1.0.0";

        src = ./.;

        # The hash of the npm dependencies
        # Run `nix build` and it will tell you the correct hash to use
        npmDepsHash = "sha256-nAcI3L0fvVI/CdUxWYg8ZiPRDjF7dW+dcIKC3KlHjNQ=";

        nativeBuildInputs = with pkgs; [
          python313
          pythonEnv
          sqlite
        ];

        buildInputs = with pkgs; [
          sqlite
        ];

        # Don't run the default npm build script
        dontNpmBuild = true;

        postInstall = ''
          # Create wrapper scripts
          mkdir -p $out/bin

          cat > $out/bin/paperless-ai << EOF
          #!${pkgs.bash}/bin/bash
          export PATH="${nodejs}/bin:${pythonEnv}/bin:\$PATH"
          export NODE_ENV=production

          # Create a writable working directory
          WORK_DIR="\''${XDG_DATA_HOME:-\$HOME/.local/share}/paperless-ai"
          mkdir -p "\$WORK_DIR"

          # Copy application files if they don't exist
          if [ ! -f "\$WORK_DIR/server.js" ]; then
            echo "Setting up Paperless-AI in \$WORK_DIR..."
            cp -r $out/lib/node_modules/paperless-ai/* "\$WORK_DIR/"
            chmod -R u+w "\$WORK_DIR"
          fi

          # Ensure data directory exists
          mkdir -p "\$WORK_DIR/data"

          cd "\$WORK_DIR"
          exec ${nodejs}/bin/node server.js "\$@"
          EOF
          chmod +x $out/bin/paperless-ai

          cat > $out/bin/paperless-ai-rag << EOF
          #!${pkgs.bash}/bin/bash
          export PATH="${pythonEnv}/bin:\$PATH"

          # Create a writable working directory
          WORK_DIR="\''${XDG_DATA_HOME:-\$HOME/.local/share}/paperless-ai"
          mkdir -p "\$WORK_DIR"

          # Copy application files if they don't exist
          if [ ! -f "\$WORK_DIR/main.py" ]; then
            echo "Setting up Paperless-AI RAG service in \$WORK_DIR..."
            cp -r $out/lib/node_modules/paperless-ai/* "\$WORK_DIR/"
            chmod -R u+w "\$WORK_DIR"
          fi

          # Ensure data directory exists
          mkdir -p "\$WORK_DIR/data"

          cd "\$WORK_DIR"
          exec ${pythonEnv}/bin/python main.py "\$@"
          EOF
          chmod +x $out/bin/paperless-ai-rag
        '';

        meta = with pkgs.lib; {
          description = "AI-powered extension for Paperless-ngx that brings automatic document classification, smart tagging, and semantic search";
          homepage = "https://github.com/clusterzx/paperless-ai";
          license = licenses.mit;
          maintainers = [];
          platforms = platforms.linux ++ platforms.darwin;
        };
      };
    in {
      packages = {
        default = paperless-ai;
      };

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          # Node.js development
          nodejs
          nodePackages.npm
          nodePackages.nodemon
          nodePackages.eslint
          nodePackages.prettier

          # Python development
          pythonEnv
          python313Packages.pip
          python313Packages.black
          python313Packages.flake8
          python313Packages.mypy

          # Database
          sqlite

          # Development tools
          git
          curl
          jq

          # Docker (if available)
          docker
          docker-compose
        ];

        shellHook = ''
                      echo "🚀 Paperless-AI Development Environment"
                      echo "Node.js version: $(node --version)"
                      echo "Python version: $(python --version)"
                      echo "SQLite version: $(sqlite3 --version)"
                      echo ""
                      echo "Available commands:"
                      echo "  npm install    - Install Node.js dependencies"
                      echo "  npm test       - Start development server with nodemon"
                      echo "  python main.py - Start RAG service"
                      echo "  docker-compose up - Start with Docker"
                      echo ""
                      echo "Environment variables to consider setting:"
                      echo "  PAPERLESS_URL - URL to your Paperless-ngx instance"
                      echo "  OPENAI_API_KEY - OpenAI API key (optional)"
                      echo "  RAG_SERVICE_URL - RAG service URL (default: http://localhost:8000)"
                      echo ""

                      # Ensure node_modules exists for development
                      if [ ! -d "node_modules" ]; then
                        echo "Installing Node.js dependencies..."
                        npm install
                      fi

                      # Download NLTK data if needed
                      python -c "
          import nltk
          try:
              nltk.data.find('tokenizers/punkt')
              nltk.data.find('corpora/stopwords')
          except LookupError:
              print('Downloading required NLTK data...')
              nltk.download('punkt')
              nltk.download('stopwords')
              print('NLTK data downloaded successfully!')
          "
        '';

        # Set environment variables
        NODE_ENV = "development";
        RAG_SERVICE_URL = "http://localhost:8000";
        RAG_SERVICE_ENABLED = "true";
      };

      # Additional development shells for specific purposes
      devShells.python-only = pkgs.mkShell {
        buildInputs = with pkgs; [
          pythonEnv
          python313Packages.pip
          python313Packages.black
          python313Packages.flake8
          python313Packages.mypy
          sqlite
        ];

        shellHook = ''
          echo "🐍 Python-only development environment for RAG service"
          echo "Python version: $(python --version)"
          echo ""
          echo "Run: python main.py"
        '';
      };

      devShells.nodejs-only = pkgs.mkShell {
        buildInputs = with pkgs; [
          nodejs
          nodePackages.npm
          nodePackages.nodemon
          nodePackages.eslint
          nodePackages.prettier
          sqlite
        ];

        shellHook = ''
          echo "📦 Node.js-only development environment for web service"
          echo "Node.js version: $(node --version)"
          echo ""
          echo "Run: npm test (or nodemon server.js)"
        '';
      };

      # Apps for easy running
      apps = {
        default = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai";
        };
        paperless-ai = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai";
        };
        rag-service = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai-rag";
        };
      };
    });
}
